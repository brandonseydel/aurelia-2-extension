import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import {
    PrepareRenameParams,
    RenameParams,
    WorkspaceEdit,
    TextEdit,
    TextDocumentEdit,
    Range as LSPRange
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, DetailedMapping, AureliaProjectComponentMap, AureliaComponentInfo } from '../common/types'; 
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';
import { getTagAtOffset } from '../utils/htmlParsing';
import { getWordRangeAtPosition } from '../utils/utilities';
import { toKebabCase } from '../core/componentScanner';

// +++ Define Cache Type +++
type ViewModelMembersCache = Map<string, { content: string | undefined; members: string[] }>;

// +++ Added Helper Function +++
function findNodeAtOffset(sourceFile: ts.SourceFile, offset: number): ts.Node | undefined {
    let foundNode: ts.Node | undefined;
    function find(node: ts.Node) {
        if (offset >= node.getStart() && offset <= node.getEnd()) {
            if (!foundNode || (node.getEnd() - node.getStart() < foundNode.getEnd() - foundNode.getStart())) {
                foundNode = node;
            }
            ts.forEachChild(node, find);
        }
    }
    find(sourceFile);
    return foundNode;
}
// +++ End Helper Function +++

// +++ Add Helper: Find HTML files +++
function findHtmlFilesRecursive(dir: string, allFiles: string[] = []): string[] {
    try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filePath = path.join(dir, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    // TODO: Consider adding node_modules exclusion here for performance
                    if (path.basename(filePath) !== 'node_modules') {
                        findHtmlFilesRecursive(filePath, allFiles);
                    }
                } else if (filePath.endsWith('.html')) {
                    allFiles.push(filePath);
                }
            } catch (e) {
                 // Ignore errors for single file/stat (e.g., permission denied)
                 log('warn', `[findHtmlFilesRecursive] Error processing ${filePath}: ${e}`);
            }
        });
    } catch (e) {
        // Ignore errors for readdir (e.g., directory not found)
        log('error', `[findHtmlFilesRecursive] Error reading directory ${dir}: ${e}`);
    }
    return allFiles;
}
// +++ End Helper +++

/**
 * Handles prepare rename requests.
 */
export async function handlePrepareRenameRequest(
    params: PrepareRenameParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap
): Promise<LSPRange | { range: LSPRange, placeholder: string } | null> {
    const triggerUri = params.textDocument.uri;
    const document = documents.get(triggerUri);
    if (!document) return null; 

    const offset = document.offsetAt(params.position);

    if (triggerUri.endsWith('.html')) {
        const text = document.getText();
        const tagInfo = await getTagAtOffset(text, offset);

        if (tagInfo) {
            log('debug', `[onPrepareRename] Found tag '${tagInfo.tagName}' at offset ${offset}. Type: ${tagInfo.type}`);
            const componentInfo = aureliaProjectComponents.get(tagInfo.tagName);

            if (componentInfo && (componentInfo.type === 'element' || componentInfo.type === 'attribute')) {
                 log('debug', `[onPrepareRename] Tag '${tagInfo.tagName}' is a known Aurelia ${componentInfo.type}. Allowing rename.`);
                
                 let renameRange: LSPRange | undefined;
                 if (tagInfo.locations) {
                     const relevantLocation = tagInfo.type === 'start' ? tagInfo.locations.startTag : tagInfo.locations.endTag;
                     if (relevantLocation) {
                         const startOffsetCorrection = tagInfo.type === 'start' ? 1 : 2;
                         const startPos = document.positionAt(relevantLocation.startOffset + startOffsetCorrection);
                         const endPos = document.positionAt(relevantLocation.startOffset + startOffsetCorrection + tagInfo.tagName.length);
                         renameRange = LSPRange.create(startPos, endPos);
                     }
                 }

                 if (!renameRange) {
                      log('warn', `[onPrepareRename] Could not get precise location for tag '${tagInfo.tagName}' from parser. Using word range fallback.`);
                     const wordRange = getWordRangeAtPosition(document, params.position);
                     if (wordRange && document.getText(wordRange) === tagInfo.tagName) {
                        renameRange = wordRange;
                     } else {
                         log('warn', `[onPrepareRename] Fallback word range check failed for tag '${tagInfo.tagName}'. Denying rename.`);
                         return null;
                     }
                 }

                 log('info', `[onPrepareRename] Allowing rename for tag '${tagInfo.tagName}' at range: ${JSON.stringify(renameRange)}`);
                 return renameRange; 
            } else {
                log('debug', `[onPrepareRename] Tag '${tagInfo.tagName}' found, but it's not a known Aurelia component. Passing through.`);
            }
        }
    } else if (triggerUri.endsWith('.ts')) {
        const program = languageService.getProgram();
        const sourceFile = program?.getSourceFile(URI.parse(triggerUri).fsPath);

        if (sourceFile && program) {
            const checker = program.getTypeChecker();
            const node = findNodeAtOffset(sourceFile, offset);

            if (node && ts.isIdentifier(node) && node.parent && ts.isClassDeclaration(node.parent)) {
                const classDeclaration = node.parent;
                const className = classDeclaration.name?.getText(sourceFile);
                if (className) {
                    for (const [name, componentInfo] of aureliaProjectComponents.entries()) {
                        const implicitName = toKebabCase(className);
                        const componentUri = URI.parse(componentInfo.uri).fsPath;
                        const currentFileFsPath = URI.parse(triggerUri).fsPath;

                        if (componentInfo.className === className && componentUri === currentFileFsPath) {
                            if (componentInfo.name === implicitName || aureliaProjectComponents.has(componentInfo.name)) { 
                                log('info', `[onPrepareRename] Allowing rename for TS class '${className}' (component: ${componentInfo.name}) at range: ${node.getStart()}-${node.getEnd()}`);
                                const startPos = document.positionAt(node.getStart());
                                const endPos = document.positionAt(node.getEnd());
                                return {
                                    range: LSPRange.create(startPos, endPos),
                                    placeholder: className
                                };
                            }
                        }
                    }
                     log('debug', `[onPrepareRename] Class '${className}' at offset ${offset} is not a known renameable Aurelia component definition.`);
                 }
             }
        }
        log('debug', `[onPrepareRename] TS file detected (${triggerUri}), but cursor at offset ${offset} not on a known Aurelia component class name.`);
    }

    if (triggerUri.endsWith('.html')) {
        const docInfo = aureliaDocuments.get(triggerUri);
        if (!docInfo) return null; 

        let activeMapping: DetailedMapping | undefined;
        for (const mapping of docInfo.mappings) {
            if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
                activeMapping = mapping;
                break;
            }
        }

        if (!activeMapping) {
            log('debug', `[onPrepareRename] HTML offset ${offset} not on tag (checked above) and not in expression.`);
            return null; 
        }
        
        const virtualOffset = mapHtmlOffsetToVirtual(offset, activeMapping); 
        log('debug', `[onPrepareRename] Mapped HTML Offset ${offset} to Virtual Offset ${virtualOffset} for expression rename.`);
    
        const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
        const virtualFile = languageService.getProgram()?.getSourceFile(virtualFsPath);
        if (!virtualFile) {
             log('warn', `[onPrepareRename] Could not get virtual source file ${virtualFsPath} from program.`);
             return null;
        }

        const definitionInfo = languageService.getDefinitionAndBoundSpan(virtualFsPath, virtualOffset);
        if (!definitionInfo || !definitionInfo.definitions || definitionInfo.definitions.length === 0) {
            log('debug', "[onPrepareRename] No definition found at virtual offset, cannot rename expression symbol.");
            return null;
        }
        const originVirtualSpan = definitionInfo.textSpan;
    
        const renameInfo = languageService.getRenameInfo(virtualFsPath, originVirtualSpan.start, { allowRenameOfImportPath: false });
        if (!renameInfo.canRename) {
            log('debug', "[onPrepareRename] TS reports rename not possible for the identified expression span.");
            return null;
        }
    
        const virtualSpanStart = originVirtualSpan.start;
        const virtualSpanEnd = virtualSpanStart + originVirtualSpan.length;
        let htmlStartOffset: number | undefined;
        let htmlEndOffset: number | undefined;
    
        const containingTransformation = activeMapping.transformations.find(t => 
            virtualSpanStart >= t.virtualRange.start && virtualSpanStart < t.virtualRange.end
        );
    
        if (containingTransformation) {
            htmlStartOffset = containingTransformation.htmlRange.start;
            const htmlLength = containingTransformation.htmlRange.end - containingTransformation.htmlRange.start;
            htmlEndOffset = containingTransformation.htmlRange.start + htmlLength; 
            log('debug', `[onPrepareRename][Expr] Using containing transformation range: ${htmlStartOffset}-${htmlEndOffset}`);
        } else {
            log('debug', `[onPrepareRename][Expr] Virtual span ${virtualSpanStart}-${virtualSpanEnd} not in transformation. Mapping manually.`);
            let accumulatedOffsetDeltaBeforeStart = 0;
            for (const transform of activeMapping.transformations) {
                if (transform.virtualRange.end <= virtualSpanStart) {
                    accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                }
            }
            const baseHtmlOffset = activeMapping.htmlExpressionLocation.startOffset;
            const baseVirtualOffset = activeMapping.virtualValueRange.start;
            htmlStartOffset = baseHtmlOffset + (virtualSpanStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
            const spanLength = virtualSpanEnd - virtualSpanStart;
            htmlEndOffset = htmlStartOffset + spanLength;
        }
    
        const htmlExprStart = activeMapping.htmlExpressionLocation.startOffset;
        const htmlExprEnd = activeMapping.htmlExpressionLocation.endOffset;
        const clampedHtmlStart = Math.max(htmlStartOffset ?? htmlExprStart, htmlExprStart); 
        let clampedHtmlEnd = Math.min(htmlEndOffset ?? htmlExprEnd, htmlExprEnd); 
        clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);
    
        if (clampedHtmlStart > htmlExprEnd || clampedHtmlEnd < clampedHtmlStart || htmlStartOffset === undefined || htmlEndOffset === undefined) {
            log('warn', `[onPrepareRename][Expr] Invalid mapped HTML range after clamping [${clampedHtmlStart}-${clampedHtmlEnd}], original: [${htmlStartOffset}-${htmlEndOffset}]`);
            return null;
        }
    
        const htmlRange = LSPRange.create(
            document.positionAt(clampedHtmlStart),
            document.positionAt(clampedHtmlEnd)
        );
        const placeholder = document.getText(htmlRange);
    
        log('info', `[onPrepareRename] Rename possible for range (expression): ${JSON.stringify(htmlRange)}, placeholder: ${placeholder}`);
        return { range: htmlRange, placeholder };
    }

    log('debug', `[onPrepareRename] Offset ${offset} in ${triggerUri} did not correspond to a renameable Aurelia entity (tag, decorator name, or expression symbol).`);
    return null; 
}

/**
 * Handles rename requests.
 */
export async function handleRenameRequest(
    params: RenameParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap
): Promise<WorkspaceEdit | undefined> {
    log('info', `[onRenameRequest] Handler Entered. URI: ${params.textDocument.uri}, New Name: ${params.newName}`);
    
    const triggerUri = params.textDocument.uri;
    const document = documents.get(triggerUri);
    if (!document) return undefined;

    const offset = document.offsetAt(params.position);
    const newName = params.newName;
    const documentChanges: TextDocumentEdit[] = [];
    const editsByUri: Map<string, TextEdit[]> = new Map(); // Helper map

    function addEdit(uri: string, edit: TextEdit) {
        if (!editsByUri.has(uri)) {
            editsByUri.set(uri, []);
        }
        editsByUri.get(uri)?.push(edit);
    }

    let isCustomElementRename = false;
    let oldName: string | undefined;
    let componentInfo: AureliaComponentInfo | undefined;

    // <<< Get workspaceRoot from languageService or connection options (assuming it's available)
    // This needs to be correctly obtained from the server initialization or settings
    const program = languageService.getProgram();
    const workspaceRoot = program?.getCurrentDirectory() ?? process.cwd(); 
    log('debug', `[onRenameRequest] Determined workspace root: ${workspaceRoot}`);

    // --- Determine Rename Type: Custom Element or Expression Symbol --- 

    if (triggerUri.endsWith('.html')) {
        const tagInfo = await getTagAtOffset(document.getText(), offset);
        if (tagInfo) {
            componentInfo = aureliaProjectComponents.get(tagInfo.tagName);
            if (componentInfo && (componentInfo.type === 'element' || componentInfo.type === 'attribute')) {
                 isCustomElementRename = true;
                 oldName = tagInfo.tagName;
                 log('debug', `[onRenameRequest] Detected rename trigger on HTML tag: ${oldName}`);
            }
        }
    } else if (triggerUri.endsWith('.ts')) {
        const sourceFile = program?.getSourceFile(URI.parse(triggerUri).fsPath);
        if (sourceFile) {
            const node = findNodeAtOffset(sourceFile, offset);
            if (node && ts.isIdentifier(node) && node.parent && ts.isClassDeclaration(node.parent)) {
                const className = node.parent.name?.getText(sourceFile);
                const currentFileFsPath = URI.parse(triggerUri).fsPath;
                if (className) {
                     // Find the component defined by this class in this file
                     for (const [name, info] of aureliaProjectComponents.entries()) {
                        if (info.className === className && URI.parse(info.uri).fsPath === currentFileFsPath) {
                             isCustomElementRename = true;
                             oldName = info.name; // The tag name associated with the class
                             componentInfo = info;
                             log('debug', `[onRenameRequest] Detected rename trigger on TS class: ${className} (Component: ${oldName})`);
                             break;
                         }
                    }
                }
            }
        }
    }

    // --- Perform Rename based on Type ---

    if (isCustomElementRename && oldName && componentInfo) {
        // <<< Add log to confirm oldName, especially for implicit case >>>
        log('info', `[onRenameRequest] Processing Custom Element rename. Identified oldName: '${oldName}', newName: '${newName}'`);

        // 1. Find and Add HTML Edits
        log('debug', `[onRenameRequest] Searching for HTML tag '${oldName}' uses in workspace: ${workspaceRoot}...`);
        // <<< Use recursive file search instead of documents.all() >>>
        const htmlFilePaths = findHtmlFilesRecursive(workspaceRoot);
        log('debug', `[onRenameRequest] Found ${htmlFilePaths.length} HTML files to check.`);
        
        // Regex to find start and end tags, carefully targeting only the name
        // <old-name ...>, </old-name>
        // Need to escape oldName in case it contains regex special chars
        const escapedOldName = oldName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const startTagRegex = new RegExp(`(<)(${escapedOldName})(\\s|>)`, 'gi');
        const endTagRegex = new RegExp(`(<\\/)(${escapedOldName})(>)`, 'gi');
        
        // <<< Iterate through file paths >>>
        for (const htmlFilePath of htmlFilePaths) {
            try {
                const text = fs.readFileSync(htmlFilePath, 'utf-8');
                const htmlDocUri = URI.file(htmlFilePath).toString(); // Get URI for edits
                let match;
                let editsFoundInFile = false;

                // <<< Add logging for regex execution >>>
                log('debug', `  - Checking file: ${htmlFilePath}`);
                log('debug', `    - Start Tag Regex: ${startTagRegex}`);
                log('debug', `    - End Tag Regex: ${endTagRegex}`);

                while ((match = startTagRegex.exec(text)) !== null) {
                     const startOffset = match.index + match[1].length;
                    const endOffset = startOffset + match[2].length;
                    // Need a temporary TextDocument to convert offsets to positions
                    const tempDoc = TextDocument.create(htmlDocUri, 'html', 0, text);
                    const range = LSPRange.create(tempDoc.positionAt(startOffset), tempDoc.positionAt(endOffset));
                    addEdit(htmlDocUri, TextEdit.replace(range, newName));
                    editsFoundInFile = true;
                    log('debug', `    - Found start tag match at index ${match.index} in ${htmlFilePath}`);
                }

                while ((match = endTagRegex.exec(text)) !== null) {
                    const startOffset = match.index + match[1].length;
                    const endOffset = startOffset + match[2].length;
                     const tempDoc = TextDocument.create(htmlDocUri, 'html', 0, text);
                    const range = LSPRange.create(tempDoc.positionAt(startOffset), tempDoc.positionAt(endOffset));
                    addEdit(htmlDocUri, TextEdit.replace(range, newName));
                    editsFoundInFile = true;
                    log('debug', `    - Found end tag match at index ${match.index} in ${htmlFilePath}`);
                }
                if (editsFoundInFile) {
                    log('info', `[onRenameRequest] Found tag uses in: ${htmlFilePath}`);
                }
            } catch (e) {
                log('error', `[onRenameRequest] Error reading or processing HTML file ${htmlFilePath}: ${e}`);
            }
        }

        // 2. Find and Add TypeScript Edits
        const tsUri = componentInfo.uri;
        const tsFsPath = URI.parse(tsUri).fsPath;
        const sourceFile = program?.getSourceFile(tsFsPath);

        if (sourceFile) {
            // <<< Hoist tsDocument acquisition >>>
            let tsDocument = documents.get(tsUri);
            let docReadError = false;
            if (!tsDocument) {
                try {
                    const fileContent = fs.readFileSync(tsFsPath, 'utf-8');
                    tsDocument = TextDocument.create(tsUri, 'typescript', 0, fileContent);
                    log('debug', `  - Read TS document ${tsUri} needed for edits.`);
                } catch (e) {
                    log('error', `[onRenameRequest] Failed to read TS file ${tsFsPath} required for TS edits: ${e}`);
                    docReadError = true;
                }
            }
            // <<< Proceed only if document is available >>>
            if (tsDocument && !docReadError) { 
                log('debug', `[onRenameRequest] Analyzing TS definition file: ${tsUri}`);
                let decoratorFound = false;
                let importFound = false;
                let importName = 'customElement'; // Default import name
                let importStatementToAdd: TextEdit | undefined;
                if (componentInfo.className) { 
                    const classNode = findNodeByClassName(sourceFile, componentInfo.className);

                    if (classNode && ts.isClassDeclaration(classNode)) {
                        // --- Refined Decorator Handling --- 
                        let existingDecoratorToModify: ts.Decorator | undefined;
                        let nameLiteralToReplace: ts.StringLiteral | undefined;

                        const decorators = ts.getDecorators ? ts.getDecorators(classNode) : undefined;
                        if (decorators) {
                            for (const decorator of decorators) {
                                if (ts.isCallExpression(decorator.expression) && ts.isIdentifier(decorator.expression.expression)) {
                                    const decoratorId = decorator.expression.expression;
                                    if (decoratorId.getText(sourceFile) === 'customElement') { // Found @customElement(...)
                                         existingDecoratorToModify = decorator;
                                         log('debug', `  - Found @customElement decorator.`);
                                         if (decorator.expression.arguments.length > 0) {
                                             const arg = decorator.expression.arguments[0];
                                             if (ts.isStringLiteral(arg) && arg.text === oldName) {
                                                 // Case 1: @customElement('old-name')
                                                 log('debug', `    - Found direct string argument matching oldName: '${arg.text}'`);
                                                 nameLiteralToReplace = arg;
                                                 break; // Found the exact one we need
                                             } else if (ts.isObjectLiteralExpression(arg)) {
                                                 // Case 2: @customElement({ name: 'old-name', ... })
                                                 log('debug', `    - Found object literal argument. Searching for 'name' property...`);
                                                 for (const prop of arg.properties) {
                                                     if (ts.isPropertyAssignment(prop) && 
                                                         prop.name && prop.name.getText(sourceFile) === 'name' && 
                                                         ts.isStringLiteral(prop.initializer)) {
                                                         log('debug', `      - Found name property with value: '${prop.initializer.text}'`);
                                                         if (prop.initializer.text === oldName) {
                                                             log('debug', `        - MATCH! This property value equals oldName.`);
                                                             nameLiteralToReplace = prop.initializer;
                                                             break; // Found the name property
                                                         } else {
                                                             log('debug', `        - NO MATCH: Value '${prop.initializer.text}' !== oldName '${oldName}'`);
                                                         }
                                                     }
                                                 }
                                                 if (nameLiteralToReplace) break; // Found decorator and name property
                                             }
                                         }
                                         // If decorator found but name didn't match oldName, keep searching just in case
                                         // but prioritize the one found
                                     }
                                }
                            }
                        }

                        if (existingDecoratorToModify && nameLiteralToReplace) {
                            // Modify existing decorator
                            decoratorFound = true; // Mark that we handled it
                            const range = LSPRange.create(
                                tsDocument.positionAt(nameLiteralToReplace.getStart() + 1), // +1 to exclude quote
                                tsDocument.positionAt(nameLiteralToReplace.getEnd() - 1)     // -1 to exclude quote
                            );
                            addEdit(tsUri, TextEdit.replace(range, newName));
                            log('debug', `[onRenameRequest] Updating existing @customElement decorator argument in ${tsUri} range: ${JSON.stringify(range)}`);
                        } else if (!existingDecoratorToModify) { 
                            // Add new decorator only if NO @customElement decorator exists
                            let insertPosOffset = classNode.getStart(); 
                            const decorators = ts.getDecorators ? ts.getDecorators(classNode) : undefined;
                            if (decorators && decorators.length > 0) {
                                // <<< Fix sort and types >>>
                                const sortedDecorators = [...decorators].sort((a: ts.Decorator, b: ts.Decorator) => a.getStart() - b.getStart());
                                insertPosOffset = sortedDecorators[0].getStart(); 
                                log('debug', `  - Found existing decorators. Targeting insert before the first one at offset ${insertPosOffset}`);
                            } else {
                                 log('debug', `  - No existing decorators found. Targeting insert at class start offset ${insertPosOffset}`);
                            }

                            const decoratorText = `@${importName}('${newName}')` + '\n'; 
                            const insertPosition = tsDocument.positionAt(insertPosOffset); 
                            addEdit(tsUri, TextEdit.insert(insertPosition, decoratorText));
                            log('debug', `[onRenameRequest] Adding new @customElement decorator to class ${componentInfo.className} in ${tsUri}`);

                            // Check for existing import (only need to do this when adding decorator)
                            ts.forEachChild(sourceFile, node => {
                                if (ts.isImportDeclaration(node)) {
                                    const moduleSpecifier = node.moduleSpecifier;
                                    if (ts.isStringLiteral(moduleSpecifier)) {
                                        const importPath = moduleSpecifier.text;
                                        // Use a more specific check for Aurelia 2
                                        if (importPath === '@aurelia/runtime-html' || importPath === 'aurelia') { 
                                            if (node.importClause?.namedBindings) {
                                                if (ts.isNamedImports(node.importClause.namedBindings)) {
                                                    node.importClause.namedBindings.elements.forEach(element => {
                                                        if (element.name.getText(sourceFile) === 'customElement') {
                                                            importFound = true;
                                                            importName = element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile); // Handle aliased imports
                                                        }
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            });

                            // Add import if missing
                            if (!importFound) {
                                const importStatementText = `import { customElement } from '@aurelia/runtime-html';\n`;
                                let lastImportEndOffset = 0; 
                                for (const statement of sourceFile.statements) {
                                    if (ts.isImportDeclaration(statement)) {
                                        lastImportEndOffset = Math.max(lastImportEndOffset, statement.getEnd());
                                    }
                                }
                                const finalImportStatementText = lastImportEndOffset > 0 ? `\n${importStatementText}` : importStatementText;
                                const importPosition = tsDocument.positionAt(lastImportEndOffset); 
                                importStatementToAdd = TextEdit.insert(importPosition, finalImportStatementText); 
                                log('debug', `[onRenameRequest] Adding missing 'customElement' import to ${tsUri} at offset ${lastImportEndOffset}`);
                            }
                        }
                        // --- End Refined Decorator Handling ---

                        // Add the import edit *after* potentially modifying the decorator name
                        if (importStatementToAdd) {
                            addEdit(tsUri, importStatementToAdd);
                        }
                    } else {
                         log('warn', `[onRenameRequest] Could not find class node '${componentInfo.className}' in ${tsUri}`);
                    }
                } else {
                     log('warn', `[onRenameRequest] Component info for ${oldName} is missing className.`);
                }
            } // <<< End if (tsDocument && !docReadError)
        } else {
             log('warn', `[onRenameRequest] Could not get source file for TS definition: ${tsUri}`);
        }

        // --- Convert edits map to documentChanges array --- 
        for (const [uri, edits] of editsByUri.entries()) {
            let docVersion: number | null = null;
            const openDoc = documents.get(uri);
            if (openDoc) {
                docVersion = openDoc.version;
            }
            // <<< Sort edits descending by start offset >>>
            const sortedEdits = edits.sort((a, b) => {
                // Convert positions to offsets for reliable comparison
                // Need a document reference here. If it's open, use it.
                // If it's not open (e.g., HTML file found via scan), we need its content.
                // This is tricky. Let's assume for now `documents.get(uri)` works for TS 
                // and use the tempDoc created earlier for HTML files.
                // A more robust solution might need caching content or reading again.
                let tempDocForSort: TextDocument | undefined = openDoc; 
                if (!tempDocForSort && uri.endsWith('.html')) {
                     try {
                        // Attempt to read content again for sorting if not open
                        const filePath = URI.parse(uri).fsPath;
                        tempDocForSort = TextDocument.create(uri, 'html', 0, fs.readFileSync(filePath, 'utf-8'));
                    } catch (e) {
                         log('error', `[onRenameRequest] Failed to read ${uri} for sorting edits: ${e}`);
                        return 0; // Cannot sort reliably
                    }
                } else if (!tempDocForSort) {
                    log('warn', `[onRenameRequest] Cannot get document ${uri} for sorting TS edits. Edits may apply incorrectly.`);
                     return 0; // Cannot sort reliably
                }
                
                const offsetA = tempDocForSort.offsetAt(a.range.start);
                const offsetB = tempDocForSort.offsetAt(b.range.start);
                return offsetB - offsetA; // Sort descending
            });
            documentChanges.push(TextDocumentEdit.create({ uri, version: docVersion }, sortedEdits));
        }

        log('info', `[onRenameRequest] Custom Element Rename: Returning ${documentChanges.length} TextDocumentEdits.`);
        return { documentChanges };

    } else {
        // --- Original Expression Symbol Rename Logic ---
        log('info', `[onRenameRequest] Processing Expression Symbol rename in ${triggerUri}`);
        
        const docInfo = aureliaDocuments.get(triggerUri);
        if (!docInfo) {
            log('warn', `[onRenameRequest] No Aurelia document info found for ${triggerUri} for expression rename.`);
            return undefined;
        } 

        let activeMapping: DetailedMapping | undefined;
        for (const mapping of docInfo.mappings) {
            if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
                activeMapping = mapping;
                break;
            }
        }

        if (!activeMapping) {
            log('warn', `[onRenameRequest] Offset ${offset} not within mapped expression for expression rename.`);
            return undefined; 
        }

        const virtualOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
        log('debug', `[onRenameRequest] Mapped HTML Offset ${offset} to Virtual Offset ${virtualOffset} for expression rename.`);

        const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
        let renameLocations: readonly ts.RenameLocation[] | undefined;
        try {
            // Use allowRenameOfImportPath: false for expression symbols typically
            renameLocations = languageService.findRenameLocations(virtualFsPath, virtualOffset, /*findInStrings*/ false, /*findInComments*/ false);
        } catch (e) {
            log('error', `[onRenameRequest] Error calling findRenameLocations for expression: ${e}`);
            return undefined;
        }
        
        if (!renameLocations) {
            log('warn', "[onRenameRequest] TS could not find rename locations for expression symbol.");
            return undefined;
        }

        log('info', `[onRenameRequest] Found ${renameLocations.length} potential rename locations for expression symbol.`);

        // Clear edits map as we are in a different logic path
        editsByUri.clear(); 

        for (const location of renameLocations) {
            // ... (Keep the existing complex mapping logic from the original function) ...
            // Existing code for mapping virtual locations back to HTML or TS files
            const targetFsPathRaw = location.fileName;
            const targetFsPath = targetFsPathRaw.replace(/\\/g, '/'); 
            let targetUri = URI.file(targetFsPathRaw).toString();
            const locationVirtualSpan = location.textSpan;
            const virtualStart = locationVirtualSpan.start;
            const virtualEnd = virtualStart + locationVirtualSpan.length;
            let targetRange: LSPRange | undefined;
   
            const normalizedVmFsPath = docInfo.vmFsPath.replace(/\\/g, '/');
            const normalizedVirtualFsPath = URI.parse(docInfo.virtualUri).fsPath.replace(/\\/g, '/');
   
            if (targetFsPath === normalizedVmFsPath) {
                // Case 1: Location is in the original ViewModel file
                const vmDocument = TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPathRaw) ?? ''); // Read content to map offset
                if (vmDocument) {
                    targetRange = LSPRange.create(vmDocument.positionAt(virtualStart), vmDocument.positionAt(virtualEnd));
                    log('debug', `[onRenameRequest][Expr] Mapped rename to VM file: ${targetUri} Range: ${JSON.stringify(targetRange)}`);
                }
            } else if (targetFsPath === normalizedVirtualFsPath) {
                 // Case 2: Location is in the Virtual File (map back to HTML)
                 targetUri = triggerUri; // Edit needs to be applied to the original HTML URI
                 let locationMapping = docInfo.mappings.find(m => 
                    m.virtualValueRange.start <= virtualStart && virtualEnd <= m.virtualValueRange.end
                );
                if (!locationMapping) {
                    // Fallback: Maybe it spans across mappings? Check containing mapping.
                    locationMapping = activeMapping; // Use the mapping determined at the start if specific one not found
                    if (!locationMapping || !(locationMapping.virtualValueRange.start <= virtualStart && virtualEnd <= locationMapping.virtualValueRange.end)) {
                        log('warn', `[onRenameRequest][Expr] Could not find mapping for virtual rename location [${virtualStart}-${virtualEnd}] in ${targetUri}`);
                        continue;
                    }
                }
   
                let htmlStartOffset: number;
                let htmlEndOffset: number;
                const containingTransformation = locationMapping.transformations.find(t => 
                    virtualStart >= t.virtualRange.start && virtualStart < t.virtualRange.end
                 );
   
                 if (containingTransformation) {
                     htmlStartOffset = containingTransformation.htmlRange.start;
                     const htmlLength = containingTransformation.htmlRange.end - containingTransformation.htmlRange.start;
                      // Adjust length based on the *portion* of the transformation the virtual span covers
                     // This is complex, let's try simpler span length mapping first
                     //htmlEndOffset = containingTransformation.htmlRange.start + htmlLength;
                     const spanLength = virtualEnd - virtualStart;
                     const relativeVirtualStart = virtualStart - containingTransformation.virtualRange.start;
                     // Assume mapping is mostly linear within the transformation identifier
                     htmlEndOffset = htmlStartOffset + spanLength; 
                     log('debug', `[onRenameRequest][Expr] Mapping via transformation: VS=${virtualStart} VSE=${virtualEnd} HS=${htmlStartOffset} HSE=${htmlEndOffset}`);
                 } else {
                      let accumulatedOffsetDeltaBeforeStart = 0;
                      for (const transform of locationMapping.transformations) {
                          if (transform.virtualRange.end <= virtualStart) {
                              accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                          }
                      }
                      const baseHtmlOffset = locationMapping.htmlExpressionLocation.startOffset;
                      const baseVirtualOffset = locationMapping.virtualValueRange.start;
                      htmlStartOffset = baseHtmlOffset + (virtualStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
                      const spanLength = virtualEnd - virtualStart;
                      htmlEndOffset = htmlStartOffset + spanLength;
                      log('debug', `[onRenameRequest][Expr] Mapping via offset calc: VS=${virtualStart} VSE=${virtualEnd} HS=${htmlStartOffset} HSE=${htmlEndOffset}`);
                 }
   
                // Clamp and validate
                 const htmlExprStart = locationMapping.htmlExpressionLocation.startOffset;
                 const htmlExprEnd = locationMapping.htmlExpressionLocation.endOffset;
                 const clampedHtmlStart = Math.max(htmlStartOffset, htmlExprStart);
                 let clampedHtmlEnd = Math.min(htmlEndOffset, htmlExprEnd);
                 clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);
   
                 if (clampedHtmlStart <= htmlExprEnd && clampedHtmlEnd >= clampedHtmlStart && htmlStartOffset !== undefined && htmlEndOffset !== undefined) {
                    targetRange = LSPRange.create(document.positionAt(clampedHtmlStart), document.positionAt(clampedHtmlEnd));
                     log('debug', `[onRenameRequest][Expr] Mapped rename to HTML: ${targetUri} Range: ${JSON.stringify(targetRange)}`);
                } else {
                     log('warn', `[onRenameRequest][Expr] Invalid mapped HTML range [${clampedHtmlStart}-${clampedHtmlEnd}], Original [${htmlStartOffset}-${htmlEndOffset}] for virtual location [${virtualStart}-${virtualEnd}]`);
                     continue;
                 }
            } else {
                // Case 3: Location is in some other TS file (import, etc.)
                 const otherSourceFile = languageService.getProgram()?.getSourceFile(targetFsPathRaw);
                 if (otherSourceFile) {
                     const otherDocument = TextDocument.create(targetUri, 'typescript', 0, otherSourceFile.getFullText());
                     targetRange = LSPRange.create(otherDocument.positionAt(virtualStart), otherDocument.positionAt(virtualEnd));
                      log('debug', `[onRenameRequest][Expr] Mapped rename to other TS file: ${targetUri} Range: ${JSON.stringify(targetRange)}`);
                 } else {
                    log('warn', `[onRenameRequest][Expr] Could not get source file for other TS location: ${targetFsPathRaw}`);
                 }
            }

            if (targetRange) {
                 addEdit(targetUri, TextEdit.replace(targetRange, newName));
            }
        }
        // --- Convert edits map to documentChanges array (for expression rename) --- 
         for (const [uri, edits] of editsByUri.entries()) {
            let docVersion: number | null = null;
            const openDoc = documents.get(uri);
            if (openDoc) {
                docVersion = openDoc.version;
            }
            // <<< Also sort edits here for consistency >>>
            const sortedEdits = edits.sort((a, b) => {
                 let tempDocForSort: TextDocument | undefined = openDoc;
                 // Logic to get document content if not open (can be complex for TS)
                 // For expression renames, involved files are likely TS files from findRenameLocations
                 if (!tempDocForSort) {
                     try {
                         const filePath = URI.parse(uri).fsPath;
                         const fileContent = fs.readFileSync(filePath, 'utf-8');
                         tempDocForSort = TextDocument.create(uri, 'typescript', 0, fileContent);
                     } catch (e) {
                         log('error', `[onRenameRequest][Expr] Failed to read ${uri} for sorting edits: ${e}`);
                         return 0;
                     }
                 }
                 if (!tempDocForSort) return 0; // Should not happen if reading succeeded
                 const offsetA = tempDocForSort.offsetAt(a.range.start);
                 const offsetB = tempDocForSort.offsetAt(b.range.start);
                 return offsetB - offsetA; // Sort descending
            });
            documentChanges.push(TextDocumentEdit.create({ uri, version: docVersion }, sortedEdits));
        }

        if (documentChanges.length === 0) {
             log('info', "[onRenameRequest][Expr] No mappable locations found after processing TS results.");
             return undefined;
        }

        log('info', `[onRenameRequest] Expression Symbol Rename: Returning ${documentChanges.length} TextDocumentEdits.`);
        return { documentChanges };
    }
}

// +++ Add Helper Function +++
function findNodeByClassName(sourceFile: ts.SourceFile, className: string): ts.ClassDeclaration | undefined {
    let foundNode: ts.ClassDeclaration | undefined;
    function find(node: ts.Node) {
        if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === className) {
            foundNode = node;
            return; // Found it, stop searching this branch
        }
        if (!foundNode) { // Don't traverse deeper if already found
             ts.forEachChild(node, find);
        }
    }
    find(sourceFile);
    return foundNode;
} 