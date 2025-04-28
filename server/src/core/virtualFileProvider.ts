import * as ts from 'typescript';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, Connection, TextDocuments } from 'vscode-languageserver/node';
import { AureliaDocumentInfo, AureliaProjectComponentMap, DetailedMapping } from '../common/types';
import { log } from '../utils/logger';
import { kebabToPascalCase, fileExistsOnDisk } from '../utils/utilities';
import { extractExpressionsFromHtml } from './htmlParser';
import { updateDiagnostics } from '../featureProviders/diagnosticsProvider';

// Type for the updateDiagnostics callback
type UpdateDiagnosticsCallback = (uri: string) => void;

// +++ Define Cache Type +++
type ViewModelMembersCache = Map<string, { content: string | undefined; members: string[] }>;

/**
 * Helper function to get member names from the ViewModel TS file, using a cache.
 */
export function getViewModelMemberNames(
    vmClassName: string,
    vmFsPath: string,
    languageService: ts.LanguageService,
    viewModelMembersCache: ViewModelMembersCache,
    program: ts.Program | undefined
): string[] {
    const cachedEntry = viewModelMembersCache.get(vmFsPath); // Use passed cache

    // +++ Cache Check using file content (use passed cache) +++
    let currentContent: string | undefined;
    try {
        currentContent = cachedEntry ? ts.sys.readFile(vmFsPath) : undefined; // Read file content for cache check
    } catch (e) {
        log('error', `[getViewModelMemberNames] Error reading file for cache check: ${vmFsPath}`, e);
    }

    if (cachedEntry && currentContent !== undefined && cachedEntry.content === currentContent) {
        log('debug', `[getViewModelMemberNames] Cache HIT for ${vmFsPath} (content match)`);
        return cachedEntry.members;
    }
    log('debug', `[getViewModelMemberNames] Cache MISS for ${vmFsPath} (content mismatch or first time)`);
    // +++ End Cache Check +++

    let memberNames: string[] = [];
    if (!languageService) {
        log('error', `[getViewModelMemberNames] Language service not available.`);
        return ['message'];
    }
    program ??= languageService.getProgram();
    if (!program) {
        log('warn', '[getViewModelMemberNames] Could not get program from language service.');
        return ['message'];
    }
    const typeChecker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(vmFsPath);
    if (!sourceFile) {
        log('warn', `[getViewModelMemberNames] Could not get source file object for ${vmFsPath}.`);
        return ['message'];
    }

    // --- Analysis logic ---
    log('info', `[getViewModelMemberNames] Analyzing class '${vmClassName}' in ${vmFsPath}`);
    let classDeclaration: ts.ClassDeclaration | undefined;
    ts.forEachChild(sourceFile, node => {
        if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === vmClassName) {
            const hasExport = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false;
            if (hasExport) {
                classDeclaration = node;
            }
        }
    });

    if (classDeclaration?.name) {
        const classSymbol = typeChecker.getSymbolAtLocation(classDeclaration.name);
        if (classSymbol) {
            const classType = typeChecker.getDeclaredTypeOfSymbol(classSymbol);
            const properties = typeChecker.getPropertiesOfType(classType);
            properties.forEach(prop => {
                const propName = prop.getName();
                if (propName && propName !== 'constructor' && !propName.startsWith('_')) {
                    memberNames.push(propName);
                }
            });
        } else { log('warn', `[getViewModelMemberNames] Could not get symbol for class ${vmClassName}.`); }
    } else { log('warn', `[getViewModelMemberNames] Could not find exported class declaration node for ${vmClassName}.`); }
    // --- End Analysis logic ---

    if (memberNames.length === 0) {
        log('warn', `[getViewModelMemberNames] No members found for ${vmClassName}, using fallback.`);
        memberNames = ['message'];
    }

    // Update Cache (use passed cache)
    if (currentContent !== undefined) {
        viewModelMembersCache.set(vmFsPath, { content: currentContent, members: memberNames }); // Use passed cache
    }
    return memberNames;
}


/**
 * Generates/updates the virtual TS file content and mapping info for an HTML document.
 * Needs access to Aurelia documents map, virtual files map, language service, and connection.
 */
export function updateVirtualFile(
    htmlUri: string,
    htmlContent: string,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    virtualFiles: Map<string, { content: string; version: number }>,
    languageService: ts.LanguageService,
    documents: TextDocuments<TextDocument>,
    connection: Connection,
    viewModelMembersCache: ViewModelMembersCache,
    aureliaProjectComponentMap: AureliaProjectComponentMap,
    program: ts.Program | undefined
): boolean {
    const htmlFsPath = URI.parse(htmlUri).fsPath;
    const dirName = path.dirname(htmlFsPath);
    const baseName = path.basename(htmlFsPath, ".html");
    const vmFsPath = path.join(dirName, `${baseName}.ts`);

    if (!fileExistsOnDisk(vmFsPath)) {
        log('warn', `[updateVirtualFile] No corresponding ViewModel found for ${htmlUri} at ${vmFsPath}`);
        const oldInfo = aureliaDocuments.get(htmlUri);
        if (oldInfo) {
            virtualFiles.delete(oldInfo.virtualUri);
            aureliaDocuments.delete(htmlUri);
            // Maybe clear diagnostics explicitly here? updateDiagnostics(htmlUri, []);
        }
        return false;
    }

    // Determine ViewModel Class Name (logic copied from server.ts)
    let actualVmClassName: string | undefined;
    const fallbackVmClassName = kebabToPascalCase(baseName);
    try {
        const vmContent = ts.sys.readFile(vmFsPath);
        if (vmContent) {
            const vmSourceFile = ts.createSourceFile(vmFsPath, vmContent, ts.ScriptTarget.Latest, true);
            ts.forEachChild(vmSourceFile, node => {
                if (ts.isClassDeclaration(node) && node.name) {
                    const hasExport = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false;
                    if (hasExport) {
                        actualVmClassName = actualVmClassName ?? node.name.getText(vmSourceFile); // Take first export
                    }
                }
            });
        }
    } catch (e) {
        log('error', `[updateVirtualFile] Error reading/parsing ${vmFsPath} for class name`, e);
    }
    const vmClassName = actualVmClassName ?? fallbackVmClassName;
    log('debug', `[updateVirtualFile] Determined VM class name: ${vmClassName}`);

    // Generate virtual file URI and path
    const virtualFileUriString = URI.parse(htmlUri + ".virtual.ts").toString();
    const virtualFsPath = URI.parse(virtualFileUriString).fsPath;

    // Calculate relative import path
    let relativeImportPath = path.relative(path.dirname(virtualFsPath), vmFsPath)
        .replace(/\\/g, "/")
        .replace(/\.ts$/, "");
    if (!relativeImportPath.startsWith(".")) {
        relativeImportPath = "./" + relativeImportPath;
    }

    const { expressions, elementTags } = extractExpressionsFromHtml(htmlContent);

    // +++ Pass cache to getViewModelMemberNames +++
    const memberNames = getViewModelMemberNames(vmClassName, vmFsPath, languageService, viewModelMembersCache, program);

    // Build Virtual File Content 
    let virtualContent = `// Virtual file for ${htmlUri}\n`;
    virtualContent += `// Generated: ${new Date().toISOString()}\n\n`;
    virtualContent += `import { ${vmClassName} } from '${relativeImportPath}';\n\n`;
    virtualContent += `declare const _this: ${vmClassName};\n\n`;
    virtualContent += `// --- Expression Placeholders ---\n`;

    // <<< Identify VCs used in this specific HTML file >>>
    const usedValueConverterNames = new Set<string>();
    expressions.forEach(expr => {
        const pipeParts = expr.expression.split('|').map(p => p.trim());
        if (pipeParts.length > 1) {
            for (let i = 1; i < pipeParts.length; i++) {
                const vcPart = pipeParts[i];
                const vcName = vcPart.split(':')[0].trim(); // Get only the name before the first colon
                if (vcName && aureliaProjectComponentMap.has(vcName)) {
                    usedValueConverterNames.add(vcName);
                }
            }
        }
    });

    // <<< Add Declarations ONLY for USED VCs (No Underscore) >>>
    virtualContent += `// --- VC Placeholders (Used in this file) ---\n`;
    usedValueConverterNames.forEach(vcName => {
        // Basic placeholder
        virtualContent += `declare function ${vcName}(value: any, ...args: any[]): any;\n`;
    });
    virtualContent += `// --- End VC Placeholders ---\n\n`;

    const detailedMappings: DetailedMapping[] = [];
    let currentOffset = virtualContent.length;

    expressions.forEach((expr, index) => {
        const placeholderVarName = `___expr_${index + 1}`;
        // <<< Keep original expression for VC part, transform base >>>
        let baseExpression = expr.expression;
        const pipeParts = expr.expression.split('|').map(p => p.trim());
        let pipeSuffix = ''; // The part from the first pipe onwards
        if (pipeParts.length > 1) {
            baseExpression = pipeParts[0];
            pipeSuffix = ' | ' + pipeParts.slice(1).join(' | '); // Reconstruct the pipe part
        }

        type TransformationWithTemp = DetailedMapping['transformations'][0] & { originalVirtualStart: number };
        let currentExpressionTransformsTemp: TransformationWithTemp[] = [];
        let currentVirtualExprContent = '';

        // Perform transformation ONLY on the baseExpression
        const trimmedBase = baseExpression.trim();
        if (trimmedBase === "") {
            currentVirtualExprContent = "_this"; // Or perhaps just empty string?
        } else {
            const identifierRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
            let currentIndex = 0;
            let result = '';
            for (const match of baseExpression.matchAll(identifierRegex)) {
                const capturedIdentifier = match[1];
                const matchIndex = match.index ?? 0;
                result += baseExpression.substring(currentIndex, matchIndex);
                let replacement = match[0];
                let offsetDelta = 0;
                if (capturedIdentifier !== 'this' && memberNames.includes(capturedIdentifier) && !['true', 'false', 'null', 'undefined'].includes(capturedIdentifier)) {
                    const transformed = `_this.${capturedIdentifier}`;
                    replacement = transformed;
                    offsetDelta = 6;
                    const baseExprHtmlOffset = expr.expression.indexOf(baseExpression);
                    const htmlStart = expr.htmlLocation.startOffset + baseExprHtmlOffset + matchIndex;
                    const htmlEnd = htmlStart + capturedIdentifier.length;
                    const virtualValueRelativeStart = result.length;
                    currentExpressionTransformsTemp.push({
                        htmlRange: { start: htmlStart, end: htmlEnd },
                        virtualRange: { start: -1, end: -1 },
                        offsetDelta: offsetDelta,
                        originalVirtualStart: virtualValueRelativeStart
                    });
                }
                result += replacement;
                currentIndex = matchIndex + match[0].length;
            }
            result += baseExpression.substring(currentIndex);
            currentVirtualExprContent = result;
        }

        // <<< Combine transformed base with UNMODIFIED pipe suffix >>>
        let finalVirtualExprContent = currentVirtualExprContent;
        if (pipeSuffix) {
            finalVirtualExprContent += pipeSuffix; // <<< Add original suffix back >>>
        }

        // Construct line and calculate ranges
        const linePrefix = `const ${placeholderVarName} = (`;
        const lineSuffix = `); // Origin: ${expr.type}\n`;
        const lineContent = linePrefix + finalVirtualExprContent + lineSuffix;

        const virtualBlockStart = currentOffset;
        const virtualValueStart = virtualBlockStart + linePrefix.length;
        const virtualValueEnd = virtualValueStart + finalVirtualExprContent.length;
        const virtualBlockEnd = virtualBlockStart + lineContent.length;

        // Calculate final absolute virtual ranges for transformations (still only for base expression)
        const finalTransformations: DetailedMapping['transformations'] = currentExpressionTransformsTemp.map(t => {
            const transformedLength = (t.htmlRange.end - t.htmlRange.start) + t.offsetDelta;
            const finalVirtualStart = virtualValueStart + t.originalVirtualStart; // Use adjusted virtualValueStart
            const finalVirtualEnd = finalVirtualStart + transformedLength;
            return {
                htmlRange: t.htmlRange,
                virtualRange: { start: finalVirtualStart, end: finalVirtualEnd },
                offsetDelta: t.offsetDelta
            };
        });

        virtualContent += lineContent;
        detailedMappings.push({
            htmlExpressionLocation: expr.htmlLocation,
            virtualBlockRange: { start: virtualBlockStart, end: virtualBlockEnd },
            virtualValueRange: { start: virtualValueStart, end: virtualValueEnd }, // Store CORRECTED value range
            type: expr.type,
            transformations: finalTransformations
        });
        currentOffset = virtualBlockEnd; // Update offset for next iteration
    });

    // Store results
    const version = (virtualFiles.get(virtualFileUriString)?.version ?? 0) + 1;
    log('debug', `[updateVirtualFile] VIRTUAL content for ${virtualFileUriString} (v${version}):\n---\n${virtualContent}\n---`);
    virtualFiles.set(virtualFileUriString, { content: virtualContent, version });
    const htmlUriString = URI.parse(htmlUri).toString();
    aureliaDocuments.set(htmlUriString, {
        virtualUri: virtualFileUriString,
        mappings: detailedMappings,
        vmClassName,
        vmFsPath,
        elementTagLocations: elementTags
    });

    // Trigger diagnostics update via imported function
    setImmediate(() => updateDiagnostics(
        htmlUriString,
        documents,
        aureliaDocuments,
        languageService,
        connection
    ),
    );
    // to ensure it runs after the current event loop tick.

    return true;
}

/**
 * Helper function to map HTML offset to Virtual offset within an expression,
 * considering the offset changes from `_this.` transformations.
 */
export function mapHtmlOffsetToVirtual(offset: number, mapping: DetailedMapping): number {
    const baseHtmlOffset = mapping.htmlExpressionLocation.startOffset;
    const relativeHtmlOffset = offset - baseHtmlOffset;
    let accumulatedOffsetDelta = 0;

    // +++ Add Detailed Logging +++
    log('debug', `[mapHtmlOffsetToVirtual] INPUT: offset=${offset}, type=${mapping.type}`);
    log('debug', `  - HTML Range: [${mapping.htmlExpressionLocation.startOffset}-${mapping.htmlExpressionLocation.endOffset}]`);
    log('debug', `  - Virtual Value Range: [${mapping.virtualValueRange.start}-${mapping.virtualValueRange.end}]`);
    log('debug', `  - Calculated: baseHtmlOffset=${baseHtmlOffset}, relativeHtmlOffset=${relativeHtmlOffset}`);
    log('debug', `  - Transformations (${mapping.transformations.length}):`);
    // +++ End Logging +++

    for (const transform of mapping.transformations) {
        // +++ Add Inner Loop Logging +++
        const checkOffset = transform.htmlRange.start - baseHtmlOffset;
        const condition = checkOffset <= relativeHtmlOffset;
        log('debug', `    - Transform HTML [${transform.htmlRange.start}-${transform.htmlRange.end}], CheckOffset=${checkOffset}, Delta=${transform.offsetDelta}. Condition (${checkOffset} <= ${relativeHtmlOffset}) is ${condition}`);
        // +++ End Inner Loop Logging +++

        if (condition) { // Use <=
            accumulatedOffsetDelta += transform.offsetDelta;
            log('debug', `      -> Accumulated Delta = ${accumulatedOffsetDelta}`); // Log change
        }
    }

    let calculatedVirtualOffset = mapping.virtualValueRange.start + relativeHtmlOffset + accumulatedOffsetDelta;

    // +++ Nudge offset if HTML offset is exactly at the start of an INTERPOLATION +++
    // This handles the <tag>${|} case, pushing it from virtualStart to virtualStart + 1
    // to match the behavior of the newline case which triggers at htmlStart + 1.
    if (mapping.type === 'interpolation' && offset === mapping.htmlExpressionLocation.startOffset) {
        if (calculatedVirtualOffset < mapping.virtualValueRange.end) {
            calculatedVirtualOffset += 1;
            log('debug', `[mapHtmlOffsetToVirtual] Nudging virtual offset for exact interpolation start from ${calculatedVirtualOffset - 1} to ${calculatedVirtualOffset}`);
        }
    }
    // +++ End Nudge +++

    const clampedVirtualOffset = Math.max(mapping.virtualValueRange.start, Math.min(calculatedVirtualOffset, mapping.virtualValueRange.end));

    // +++ Add Final Logging +++
    log('debug', `  - Final Calculation: virtualStart(${mapping.virtualValueRange.start}) + relativeHtmlOffset(${relativeHtmlOffset}) + accumulatedOffsetDelta(${accumulatedOffsetDelta}) = ${calculatedVirtualOffset}`);
    log('debug', `  - Clamped Result: ${clampedVirtualOffset}`);
    // +++ End Logging +++

    return clampedVirtualOffset;
} 