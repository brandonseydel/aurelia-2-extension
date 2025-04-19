import * as ts from 'typescript';
import {
    createConnection,
    ProposedFeatures,
    TextDocuments,
    InitializeParams,
    InitializeResult,
    TextDocumentSyncKind,
    CompletionItem,
    CompletionParams,
    Position,
    CompletionItemKind,
    DefinitionParams,
    LocationLink,
    Range as LSPRange,
    Diagnostic,
    DiagnosticSeverity,
    Hover,
    MarkedString,
    HoverParams,
    SignatureHelp,
    SignatureHelpParams,
    SignatureHelpTriggerKind,
    InsertTextFormat,
    CodeAction,
    CodeActionParams,
    CodeActionKind,
    WorkspaceEdit,
    TextEdit,
    TextDocumentEdit, // <<< ADDED IMPORT
    DocumentFormattingParams,
    SemanticTokens,
    SemanticTokensParams,
    SemanticTokensBuilder,
    SemanticTokensLegend,
    SemanticTokenTypes,
    SemanticTokenModifiers,
    DidChangeWatchedFilesRegistrationOptions,
    FileSystemWatcher,
    FileChangeType,
    PrepareRenameParams,
    RenameParams,
    ReferenceParams,
    Location as LSPLocation, // <<< Aliased LSP Location
  DidChangeConfigurationNotification // Import for config changes
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import { URI } from 'vscode-uri';
import * as parse5 from 'parse5';
// Use 'any' for problematic types to bypass linter issues
import { Document, Element, Node, TextNode /*, Location, Attribute */ } from 'parse5/dist/tree-adapters/default';
type Location = any; // Bypass linter
type Attribute = any; // Bypass linter

// Make sure SignatureHelpTriggerCharacter is available if TS defines it
type SignatureHelpTriggerCharacter = ts.SignatureHelpTriggerCharacter;

// --- Basic Setup ---
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// --- Interfaces ---
interface AureliaHtmlExpression {
    expression: string; // The raw expression string
    type: 'interpolation' | 'binding';
    htmlLocation: Location; // Use bypass type
}

// Detailed mapping between HTML expression and virtual file representation
interface DetailedMapping {
    htmlExpressionLocation: Location; // Use bypass type
    virtualBlockRange: { start: number; end: number }; // Range of the entire placeholder block (e.g., const ___expr_1 = (...);)
    virtualValueRange: { start: number; end: number }; // Range of the expression value inside the block
    wasThisPrepended: boolean; // If ANY '_this.' was prepended to a member
    type: 'interpolation' | 'binding';
}

// Information stored per HTML document
interface AureliaDocumentInfo {
    virtualUri: string;
    mappings: DetailedMapping[];
    vmClassName: string; // ViewModel class name
    vmFsPath: string; // ViewModel file system path
}

// +++ MOVE Settings Interface Definition HERE +++
// Define the structure for our settings
interface AureliaServerSettings {
  logging: {
    level: 'debug' | 'log' | 'info' | 'warn' | 'error' | 'none';
  };
  diagnostics: {
    enable: boolean;
  };
  completions: {
    standardHtml: {
      enable: boolean;
    };
  };
}
// +++ END Settings Interface +++

// --- State ---
let languageService: ts.LanguageService;
let virtualFiles: Map<string, { content: string; version: number }> = new Map(); // virtualUri -> content/version
let aureliaDocuments: Map<string, AureliaDocumentInfo> = new Map(); // htmlUri -> info
let strictMode = false;
let workspaceRoot = process.cwd(); // Store workspace root
// +++ Update Map Value Type +++
let aureliaProjectComponents: Map<string, { uri: string, type: 'element' | 'attribute', name: string, bindables?: string[] }> = new Map();

let componentUpdateTimer: NodeJS.Timeout | undefined;
const componentUpdateQueue = new Set<string>();
const COMPONENT_UPDATE_DEBOUNCE_MS = 500;

// +++ MOVE Global Settings Variable HERE +++
// Global settings variable with defaults
let serverSettings: AureliaServerSettings = {
  logging: { level: 'debug' },
  diagnostics: { enable: true },
  completions: { standardHtml: { enable: true } }
};
// +++ END Global Settings Variable +++

// --- Constants ---
const AURELIA_BINDING_SUFFIXES = ['.bind', '.trigger', '.call', '.delegate', '.capture', '.ref', '.one-time', '.to-view', '.from-view', '.two-way'];
const AURELIA_TEMPLATE_CONTROLLERS = ['repeat.for', 'if', 'else', 'switch', 'case', 'default-case', 'with', 'portal', 'view', 'au-slot'];
const AURELIA_SPECIAL_ATTRIBUTES = ['view-model', 'ref', 'element.ref']; // Add others as needed

// Define the legend for semantic tokens
const tokenTypes = [SemanticTokenTypes.variable, SemanticTokenTypes.property, SemanticTokenTypes.function, SemanticTokenTypes.method, SemanticTokenTypes.keyword, SemanticTokenTypes.class, SemanticTokenTypes.type, SemanticTokenTypes.parameter];
const tokenModifiers = [SemanticTokenModifiers.declaration, SemanticTokenModifiers.definition, SemanticTokenModifiers.readonly];
// Create legend as a plain object matching the type
const legend: SemanticTokensLegend = {
    tokenTypes: tokenTypes,
    tokenModifiers: tokenModifiers
};

// --- Logging Helper ---
const LOG_LEVEL_ORDER: { [key in AureliaServerSettings['logging']['level']]: number } = {
  'debug': 1,
  'log': 2,
  'info': 3,
  'warn': 4,
  'error': 5,
  'none': 6
};

function log(level: 'error' | 'warn' | 'info' | 'log' | 'debug', message: string, ...optionalParams: any[]): void {
  const currentLevel = serverSettings.logging.level;
  if (LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLevel]) {
    let logMessage = message;
    if (optionalParams.length > 0) {
      try {
        const paramsString = optionalParams.map(p =>
          typeof p === 'object' ? JSON.stringify(p) : String(p)
        ).join(' ');
        logMessage += ` | ${paramsString}`;
      } catch (e) {
        // Log a simple error message if stringification fails
        connection.console.error("[Log Helper] Error processing optional params.");
      }
    }

    switch (level) {
      case 'error': connection.console.error(logMessage); break;
      case 'warn': connection.console.warn(logMessage); break;
      case 'info': connection.console.info(logMessage); break;
      case 'log': case 'debug': connection.console.log(logMessage); break;
    }
  }
}

// --- Helper Functions ---

function kebabToPascalCase(str: string): string {
  return str.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

// Checks if an attribute looks like an Aurelia binding command or template controller
function isAureliaAttribute(attrName: string): boolean {
    if (AURELIA_TEMPLATE_CONTROLLERS.includes(attrName)) {
        return true;
    }
    if (AURELIA_SPECIAL_ATTRIBUTES.includes(attrName)) {
        return true; // Consider these as needing expression parsing? Maybe not always.
    }
    // Check for suffixes like .bind, .trigger etc.
    if (AURELIA_BINDING_SUFFIXES.some(suffix => attrName.endsWith(suffix))) {
        return true;
    }
    // Basic check for custom attributes with bindings: contains a dot.
    if (attrName.includes('.') && !attrName.startsWith('.') && !attrName.endsWith('.')) {
        // Further refinement might be needed to avoid standard attrs with dots
        // For now, assume custom attributes might use bindings
        return true;
    }
    return false;
}

// Extracts Aurelia expressions (interpolations and bindings) from HTML
function extractExpressionsFromHtml(htmlContent: string): AureliaHtmlExpression[] {
    const expressions: AureliaHtmlExpression[] = [];
  const document = parse5.parse(htmlContent, { sourceCodeLocationInfo: true }) as Document;
    const interpolationRegex = /\${([^}]*)}/g; // Match ${...}, allow empty {}

  const traverse = (node: Node) => {
    log('debug', `[extractExpressions] Traversing node: ${node.nodeName}`);
    const hasLocation = !!node.sourceCodeLocation;

    if (!hasLocation) {
      log('debug', `[extractExpressions]   - Node ${node.nodeName} missing sourceCodeLocation, but will attempt to traverse children.`);
      // Proceed to child traversal below, but skip processing this node
    }

    // --- Process Node if Location Exists ---
    if (hasLocation) {
        // 1. Text Nodes for Interpolation: ${...}
    if (node.nodeName === '#text' && node.sourceCodeLocation) {
      const textNode = node as TextNode;
      const textContent = textNode.value;
        log('debug', `[extractExpressions]   - Found #text node with content: \"${textContent.substring(0, 50)}${textContent.length > 50 ? '...' : ''}\"`);
      let match;
            interpolationRegex.lastIndex = 0;
      while ((match = interpolationRegex.exec(textContent)) !== null) {
          log('debug', `[extractExpressions]     - REGEX MATCH FOUND: ${match[0]}`);
          const expression = match[1];
          const expressionStartOffset = textNode.sourceCodeLocation!.startOffset + match.index + 2;
                const expressionEndOffset = expressionStartOffset + expression.length;
                const startLoc = calculateLocationFromOffset(htmlContent, expressionStartOffset);
                const endLoc = calculateLocationFromOffset(htmlContent, expressionEndOffset);
                if (startLoc && endLoc) {
            // +++ Log the created mapping offsets +++
            log('debug', `[extractExpressions] Creating INTERPOLATION mapping: expr='${expression}', startOffset=${expressionStartOffset}, endOffset=${expressionEndOffset}`);
                    expressions.push({
                        expression,
                        type: 'interpolation',
                        htmlLocation: {
                            startLine: startLoc.line,
                            startCol: startLoc.col,
                            endLine: endLoc.line,
                            endCol: endLoc.col,
                            startOffset: expressionStartOffset,
                            endOffset: expressionEndOffset,
                        },
                    });
                }
        } // end while
      } // end if #text

        // 2. Element Attributes for Bindings: *.bind="..." etc.
    if ('attrs' in node && node.attrs && node.sourceCodeLocation) {
      const element = node as Element;
        log('debug', `[extractExpressions]   - Checking attributes for <${element.tagName}>`);
      for (const attr of element.attrs) {
                if (isAureliaAttribute(attr.name) && element.sourceCodeLocation?.attrs?.[attr.name]) {
            log('debug', `[extractExpressions]     - Found Aurelia attribute: ${attr.name}`);
          const attrLocation = element.sourceCodeLocation.attrs[attr.name];
            const valueStartOffset = attrLocation.startOffset + attr.name.length + 2;
            const valueEndOffset = attrLocation.endOffset - 1;
            if (valueStartOffset <= valueEndOffset) { // Use <= to handle empty values
              const expression = attr.value;
                        const startLoc = calculateLocationFromOffset(htmlContent, valueStartOffset);
                        const endLoc = calculateLocationFromOffset(htmlContent, valueEndOffset);
                        if (startLoc && endLoc) {
                // +++ Log the created mapping offsets +++
                log('debug', `[extractExpressions] Creating BINDING mapping: attr='${attr.name}', expr='${expression}', startOffset=${valueStartOffset}, endOffset=${valueEndOffset}`);
                            expressions.push({
                  expression: expression === '' ? 'true' : expression, // Handle boolean attribute case
                                type: 'binding',
                                htmlLocation: {
                                    startLine: startLoc.line,
                                    startCol: startLoc.col,
                                    endLine: endLoc.line,
                                    endCol: endLoc.col,
                                    startOffset: valueStartOffset,
                                    endOffset: valueEndOffset,
                                },
                            });
                        }
                    }
          } // end if isAureliaAttribute
        } // end for attr
      } // end if attrs

      // 4. Handle <template> content (Only if parent template has location)
      if (node.nodeName === 'template' && 'content' in node && node.content) {
        log('debug', `[extractExpressions]   - Traversing content of <template>`);
        traverse(node.content);
      }

    } // --- End of if(hasLocation) --- 

    // 3. Traverse Children (Always attempt)
    // Check if node is an Element or DocumentFragment before accessing childNodes
    if (typeof (node as any).childNodes === 'object' && (node as any).childNodes !== null) {
      const childNodes = (node as any).childNodes as Node[];
      if (childNodes.length > 0) {
        log('debug', `[extractExpressions]   - Traversing ${childNodes.length} children of ${node.nodeName}`);
        childNodes.forEach(traverse);
      }
    }
    // Check specifically for DocumentFragment content property (used by <template>)
    else if ('content' in node && node.content && typeof node.content.childNodes === 'object' && node.content.childNodes !== null) {
      const childNodes = node.content.childNodes as Node[];
      if (childNodes.length > 0) {
        log('debug', `[extractExpressions]   - Traversing ${childNodes.length} children of ${node.nodeName} <template> content`);
        childNodes.forEach(traverse);
      }
    }

  }; // end traverse function

  // traverse(document); // <<< REMOVE THIS LINE
  // +++ START TRAVERSAL FROM CHILD NODES +++
  if (document.childNodes) {
    log('debug', `[extractExpressions] Starting traversal from ${document.childNodes.length} child nodes.`);
    document.childNodes.forEach(traverse);
  } else {
    log('warn', `[extractExpressions] Document parsing resulted in no child nodes.`);
  }
  // +++ END TRAVERSAL CHANGE +++

    // Sort by start offset to ensure order
    expressions.sort((a, b) => a.htmlLocation.startOffset - b.htmlLocation.startOffset);
    // connection.console.log(`[extractExpressions] Found ${expressions.length} expressions.`); // Keep commented
  log('debug', `[extractExpressions] Found ${expressions.length} expressions.`); // Use log helper
  return expressions;
}

// Helper to convert offset to Line/Column (1-based)
function calculateLocationFromOffset(content: string, targetOffset: number): { line: number; col: number } | null {
    let line = 1;
    let col = 1;
    for (let i = 0; i < targetOffset && i < content.length; i++) {
        if (content[i] === '\n') {
            line++;
            col = 1;
        } else {
            col++;
        }
    }
    if (targetOffset > content.length) return null; // Offset out of bounds
    return { line, col };
}

// Helper function to get member names from the ViewModel TS file
function getViewModelMemberNames(vmClassName: string, vmFsPath: string): string[] {
    let memberNames: string[] = [];
        if (!languageService) {
            connection.console.error(`[getViewModelMemberNames] Language service not initialized.`);
        return ['message']; // Basic fallback
        }
        const program = languageService.getProgram();
    if (!program) {
        connection.console.warn('[getViewModelMemberNames] Could not get program from language service.');
        return ['message'];
    }

            const typeChecker = program.getTypeChecker();
            const sourceFile = program.getSourceFile(vmFsPath); 
    if (!sourceFile) {
        connection.console.warn(`[getViewModelMemberNames] Could not get source file object for ${vmFsPath}.`);
        return ['message'];
    }

    connection.console.log(`[getViewModelMemberNames] Searching for class '${vmClassName}' in ${vmFsPath}`);
                let classDeclaration: ts.ClassDeclaration | undefined;
                ts.forEachChild(sourceFile, node => {
                    if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === vmClassName) {
                        const hasExport = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false;
            // Aurelia doesn't typically use default exports for ViewModels
            if (hasExport) {
                            connection.console.log(`[getViewModelMemberNames] Found exported class declaration for: ${vmClassName}`);
                            classDeclaration = node;
                        }
                    }
                });

                if (classDeclaration?.name) {
                    const classSymbol = typeChecker.getSymbolAtLocation(classDeclaration.name);
                    if (classSymbol) {
            // Get members from the class instance type
                        const classType = typeChecker.getDeclaredTypeOfSymbol(classSymbol);
                        const properties = typeChecker.getPropertiesOfType(classType);
                        connection.console.log(`[getViewModelMemberNames] Found ${properties.length} potential members for ${vmClassName}.`);
                        properties.forEach(prop => {
                            const propName = prop.getName();
                // Basic filtering: ignore constructor, maybe private members later?
                            if (propName && propName !== 'constructor' && !propName.startsWith('_')) {
                                memberNames.push(propName);
                            }
                        });

            // Consider getting members from base classes if necessary
            // const baseTypes = typeChecker.getBaseTypes(classType);
            // baseTypes.forEach(baseType => { ... });

                    } else { connection.console.warn(`[getViewModelMemberNames] Could not get symbol for class ${vmClassName}.`); }
                } else { connection.console.warn(`[getViewModelMemberNames] Could not find exported class declaration node for ${vmClassName}.`); }

    connection.console.log(`[getViewModelMemberNames] Final members for ${vmClassName}: [${memberNames.join(', ')}]`);
    if (memberNames.length === 0) { 
      connection.console.warn(`[getViewModelMemberNames] No members found dynamically for ${vmClassName}, using fallback.`);
        memberNames = ['message']; // Fallback
    }
    return memberNames;
}

// Generates/updates the virtual TS file for an HTML document
function updateVirtualFile(htmlUri: string, htmlContent: string): boolean {
  const htmlFsPath = URI.parse(htmlUri).fsPath;
    const dirName = path.dirname(htmlFsPath);
    const baseName = path.basename(htmlFsPath, ".html");

    // Try to find matching .ts file
    const vmFsPath = path.join(dirName, `${baseName}.ts`);
    if (!fileExistsOnDisk(vmFsPath)) {
        connection.console.warn(`[updateVirtualFile] No corresponding ViewModel found for ${htmlUri} at ${vmFsPath}`);
        // Clean up if previously existed
        const oldInfo = aureliaDocuments.get(htmlUri);
        if (oldInfo) {
            virtualFiles.delete(oldInfo.virtualUri);
            aureliaDocuments.delete(htmlUri);
        }
        return false; // Indicate failure
    }

    // --- Determine ViewModel Class Name --- 
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
                        if (actualVmClassName) {
                            log('warn', `[updateVirtualFile] Found multiple exported classes in ${vmFsPath}. Using the first one found: ${actualVmClassName}.`);
                        } else {
                            actualVmClassName = node.name.getText(vmSourceFile);
                            log('debug', `[updateVirtualFile] Found exported class: ${actualVmClassName} in ${vmFsPath}`);
                        }
                    }
                }
            });
        }
    } catch (e) {
        log('error', `[updateVirtualFile] Error reading or parsing ${vmFsPath} to find class name: ${e}`);
    }

    if (!actualVmClassName) {
        log('warn', `[updateVirtualFile] Could not find exported class in ${vmFsPath}. Using fallback name: ${fallbackVmClassName}`);
        actualVmClassName = fallbackVmClassName;
    }
    const vmClassName = actualVmClassName; // Use the determined or fallback name
    // ------------------------------------

    // +++ Ensure normalized URI for virtual file +++
    const virtualFileUriString = URI.parse(htmlUri + ".virtual.ts").toString();
    const virtualFsPath = URI.parse(virtualFileUriString).fsPath;
    
    // Calculate relative path for import
    let relativeImportPath = path.relative(path.dirname(virtualFsPath), vmFsPath)
        .replace(/\\/g, "/") // Normalize path separators
        .replace(/\.ts$/, ""); // Remove .ts extension
    if (!relativeImportPath.startsWith(".")) {
        relativeImportPath = "./" + relativeImportPath;
    }
  
    const expressions = extractExpressionsFromHtml(htmlContent);
    // Fetch member names AFTER confirming VM exists and BEFORE generating virtual content
    // +++ Use the determined vmClassName +++
    const memberNames = getViewModelMemberNames(vmClassName, vmFsPath);

    // --- Build Virtual File Content --- 
    let virtualContent = `// Virtual file for ${htmlUri}\n`;
    virtualContent += `// Generated: ${new Date().toISOString()}\n\n`;
    // +++ Use the determined vmClassName +++
    virtualContent += `import { ${vmClassName} } from '${relativeImportPath}';\n\n`;
    virtualContent += `// Declare the 'this' context for the template\n`;
    // +++ Use the determined vmClassName +++
    virtualContent += `declare const _this: ${vmClassName};\n\n`;
    virtualContent += `// --- Expression Placeholders ---\n`;
  
    const detailedMappings: DetailedMapping[] = [];
    let currentOffset = virtualContent.length; // Track position in virtual file

    expressions.forEach((expr, index) => {
        const placeholderVarName = `___expr_${index + 1}`;
        let wasThisPrepended = false;
        let transformedExpression = expr.expression;
        const trimmedOriginal = expr.expression.trim();

        if (trimmedOriginal !== "") {
            // Apply '_this.' transformation logic
            // Regex: word boundary, identifier (must not be preceded by .), word boundary
            const identifierRegex = /(?<!\.)\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
            transformedExpression = transformedExpression.replace(identifierRegex, (match, capturedIdentifier) => {
                // Skip 'this' itself
                if (capturedIdentifier === 'this') {
                return match;
            }
                // Check if it's a known member (and not a global like 'true', 'false', 'null')
                if (memberNames.includes(capturedIdentifier) && !['true', 'false', 'null', 'undefined'].includes(capturedIdentifier)) {
                    // Basic check to avoid prefixing known globals/keywords shadowed by members
                    // A more robust check might involve TS symbol analysis if needed
                wasThisPrepended = true;
                    return `_this.${capturedIdentifier}`;
                }
                // Maybe check for built-in JS globals like Math, Date? For now, assume non-members are ok.
                return match; // Return original identifier if not a member
            });
        } else {
      // Handle empty expressions: Generate `_this` to provide context
      transformedExpression = "_this"; // <<< CHANGE: Use _this instead of ''
        }


    // Construct the line: const ___expr_N = (transformed_expression);
    const linePrefix = `const ${placeholderVarName} = (`;
        // Ensure backticks and ${} inside the original expression are handled correctly if we embed it in a comment.
        // Simpler: just note the type.
        const lineSuffix = `); // Origin: ${expr.type}\n`;
    const lineContent = linePrefix + transformedExpression + lineSuffix;

        const virtualBlockStart = currentOffset;
        const virtualBlockEnd = virtualBlockStart + lineContent.length;
        const virtualValueStart = virtualBlockStart + linePrefix.length;
        const virtualValueEnd = virtualValueStart + transformedExpression.length;

    virtualContent += lineContent;

    detailedMappings.push({
            htmlExpressionLocation: expr.htmlLocation,
            virtualBlockRange: { start: virtualBlockStart, end: virtualBlockEnd },
            virtualValueRange: { start: virtualValueStart, end: virtualValueEnd },
        wasThisPrepended: wasThisPrepended, 
            type: expr.type,
    });

        currentOffset = virtualBlockEnd;
    });

  // Store virtual file content and mapping info using normalized URI string
  const version = (virtualFiles.get(virtualFileUriString)?.version ?? 0) + 1;
  log('debug', `[updateVirtualFile] VIRTUAL content for ${virtualFileUriString} (v${version}):\n---\n${virtualContent}\n---`);
  virtualFiles.set(virtualFileUriString, { content: virtualContent, version });
  // +++ Ensure aureliaDocuments also uses the normalized HTML URI string key +++
  const htmlUriString = URI.parse(htmlUri).toString();
  // +++ Store the determined vmClassName +++
  aureliaDocuments.set(htmlUriString, { virtualUri: virtualFileUriString, mappings: detailedMappings, vmClassName, vmFsPath });

    // Trigger diagnostics update for this virtual file
  updateDiagnostics(htmlUriString); // Pass normalized URI string

    return true; // Indicate success
}

// Function to explicitly check if a file exists on disk
function fileExistsOnDisk(filePath: string): boolean {
  try {
    return ts.sys.fileExists(filePath);
  } catch (e) {
    connection.console.error(`[fileExistsOnDisk] Error checking ${filePath}: ${e}`);
    return false;
  }
}

// --- Language Service Creation and Host ---
function createLanguageServiceInstance(workspaceRoot: string): ts.LanguageService {
    let compilerOptions: ts.CompilerOptions = {
        // Defaults - these will be overridden by tsconfig.json if found
        strict: strictMode,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs, // Or Bundler for newer TS/Node
        esModuleInterop: true,
        allowJs: true, // Important for mixed projects
        allowSyntheticDefaultImports: true,
        baseUrl: workspaceRoot,
        // Aurelia specific defaults (consider adding if no tsconfig)
        // experimentalDecorators: true,
        // emitDecoratorMetadata: true,
    };

  const configFileName = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, "tsconfig.json");
    let projectFiles: string[] = []; // Track files included by tsconfig
  
  if (configFileName) {
    connection.console.log(`[createLanguageServiceInstance] Found tsconfig.json at: ${configFileName}`);
    const configFile = ts.readConfigFile(configFileName, ts.sys.readFile);
    if (configFile.error) {
      connection.console.error(`[createLanguageServiceInstance] Error reading tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
    } else {
            // Use project directory as context for parsing
            const projectDir = path.dirname(configFileName);
      const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config, 
        ts.sys, 
                projectDir, // Context directory
                compilerOptions, // Pass existing defaults to be potentially overridden
        configFileName
      );

      if (parsedConfig.errors.length > 0) {
        connection.console.warn(`[createLanguageServiceInstance] Errors parsing tsconfig.json:`);
        parsedConfig.errors.forEach(error => {
          connection.console.warn(`  - ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
        });
            }
            // Use parsed options even if there are errors
        compilerOptions = parsedConfig.options;
            projectFiles = parsedConfig.fileNames; // Store the list of files TS knows about
            connection.console.log(`[createLanguageServiceInstance] Parsed tsconfig.json. Effective CompilerOptions: ${JSON.stringify(compilerOptions)}`);
             connection.console.log(`[createLanguageServiceInstance] TS project includes ${projectFiles.length} files.`);
    }
  } else {
        connection.console.log(`[createLanguageServiceInstance] No tsconfig.json found. Using default compiler options.`);
        // In absence of tsconfig, maybe scan workspace? For simplicity, rely on open files + virtual files for now.
    }

    // Ensure crucial options
    compilerOptions.allowJs = true;
    // compilerOptions.experimentalDecorators = true; // Often needed for Aurelia v1/v2
  
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => {
      const fileUris = new Set<string>();
      // 1. Add open real documents (.ts)
            documents.keys().forEach(uri => {
        if (uri.endsWith('.ts') && !uri.endsWith('.virtual.ts')) {
                    fileUris.add(uri);
                }
            });
            // 2. Add virtual files
            virtualFiles.forEach((_val, uri) => fileUris.add(uri));

      // +++ RE-INCLUDE files from tsconfig.json +++
             projectFiles.forEach(filePath => fileUris.add(URI.file(filePath).toString()));
      // +++++++++++++++++++++++++++++++++++++++++++

            const uniqueFsPaths = Array.from(fileUris).map(uri => URI.parse(uri).fsPath);
      // Log the combined list
      log('debug', `[Host.getScriptFileNames] (Re-including project files) Returning ${uniqueFsPaths.length} paths.`);
      uniqueFsPaths.forEach(p => log('debug', `  - Path: ${p}`));
            return uniqueFsPaths;
    },
    getScriptVersion: (fileName) => {
            const fileUri = URI.file(fileName).toString(); // Convert fsPath back to URI string
      let version = '0'; // Default
            const openDoc = documents.get(fileUri);
            if (openDoc) {
        version = openDoc.version.toString();
            }
            const virtualFile = virtualFiles.get(fileUri);
            if (virtualFile) {
        version = virtualFile.version.toString();
      }
      // +++ Add Logging +++
      // log('debug', `[Host.getScriptVersion] File: ${fileName}, Version: ${version}`);
      return version;
    },
    // +++ Add getScriptKind +++
    getScriptKind: (fileName) => {
      if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) {
        // Treat .ts, .tsx, and our .virtual.ts as TypeScript
        // Check .tsx? Might need if components use JSX.
        log('debug', `[Host.getScriptKind] TS/TSX for: ${fileName}`);
        return ts.ScriptKind.TS; // Or TSX if needed based on compiler options/usage
      }
      // Could add checks for JS/JSX if needed
      // if (fileName.endsWith('.js') || fileName.endsWith('.jsx')) {
      //     return compilerOptions.allowJs ? (fileName.endsWith('x') ? ts.ScriptKind.JSX : ts.ScriptKind.JS) : ts.ScriptKind.Unknown;
      // }
      log('debug', `[Host.getScriptKind] Unknown for: ${fileName}`);
      return ts.ScriptKind.Unknown; // Default for others (like .html)
    },
    getScriptSnapshot: (fileName) => {
            const fileUri = URI.file(fileName).toString();
      log('debug', `[Host.getScriptSnapshot] Requested for: ${fileName}`); // Log request
            const openDoc = documents.get(fileUri);
      if (openDoc) {
        log('debug', `  - Found in open documents.`);
        return ts.ScriptSnapshot.fromString(openDoc.getText());
      }
            const virtualFile = virtualFiles.get(fileUri);
      if (virtualFile) {
        log('debug', `  - Found in virtual files map.`);
        return ts.ScriptSnapshot.fromString(virtualFile.content);
      }
            // Try reading from disk if it's a known project file or potentially exists
             if (projectFiles.includes(fileName) || fileExistsOnDisk(fileName)) {
                try {
                    const content = ts.sys.readFile(fileName);
            if (content !== undefined) {
            log('debug', `  - Read from disk.`);
               return ts.ScriptSnapshot.fromString(content);
            }
         } catch (e) {
          log('error', `[Host.getScriptSnapshot] Error reading ${fileName} from disk: ${e}`);
         }
      }
      log('debug', `  - No snapshot found/created.`);
      return undefined;
    },
    getCurrentDirectory: () => {
      log('debug', `[Host.getCurrentDirectory] Returning: ${workspaceRoot}`);
      return workspaceRoot;
    },
    getCompilationSettings: () => {
      log('debug', `[Host.getCompilationSettings] Returning options.`);
      return compilerOptions;
    },
    getDefaultLibFileName: (options) => {
      const libPath = ts.getDefaultLibFilePath(options);
      log('debug', `[Host.getDefaultLibFileName] Returning: ${libPath}`);
      return libPath;
    },
    fileExists: (fileName) => {
            const fileUri = URI.file(fileName).toString();
      let exists = false;
      if (virtualFiles.has(fileUri)) {
        exists = true;
        // log('debug', `[Host.fileExists] YES (Virtual): ${fileName}`);
      } else if (documents.get(fileUri)) {
        exists = true;
        // log('debug', `[Host.fileExists] YES (Open Doc): ${fileName}`);
      } else {
        exists = fileExistsOnDisk(fileName);
        // log('debug', `[Host.fileExists] ${exists ? 'YES' : 'NO'} (Disk Check): ${fileName}`);
      }
      return exists;
        },
        readFile: (fileName, encoding) => {
             const fileUri = URI.file(fileName).toString();
      log('debug', `[Host.readFile] Requested for: ${fileName}`);
             const openDoc = documents.get(fileUri);
      if (openDoc) {
        log('debug', `  - Found in open documents.`);
        return openDoc.getText();
      }
             const virtualFile = virtualFiles.get(fileUri);
      if (virtualFile) {
        log('debug', `  - Found in virtual files map.`);
        return virtualFile.content;
      }
      const content = ts.sys.readFile(fileName, encoding);
      log('debug', `  - ${content !== undefined ? 'Read from disk' : 'Not found on disk'}.`);
      return content;
    },
    readDirectory: (path, extensions, exclude, include, depth) => {
      log('debug', `[Host.readDirectory] Path: ${path}`);
      return ts.sys.readDirectory(path, extensions, exclude, include, depth);
    },
    directoryExists: (directoryName) => {
      const exists = ts.sys.directoryExists(directoryName);
      // log('debug', `[Host.directoryExists] ${exists ? 'YES' : 'NO'}: ${directoryName}`);
      return exists;
    },
    getDirectories: (directoryName) => {
      log('debug', `[Host.getDirectories] Path: ${directoryName}`);
      return ts.sys.getDirectories(directoryName);
    },
    resolveModuleNames: (moduleNames, containingFile, _reusedNames, _redirectedReference, options, containingSourceFile?) => {
      log('debug', `[Host.resolveModuleNames] Trying to resolve: [${moduleNames.join(', ')}] from ${containingFile}`);
             const resolvedModules: (ts.ResolvedModule | undefined)[] = [];
      const currentCompilerOptions = host.getCompilationSettings(); 
      
             for (const moduleName of moduleNames) {
                 // Try standard TypeScript resolution first
                 const result = ts.resolveModuleName(moduleName, containingFile, currentCompilerOptions, host); // Pass host itself
                 if (result.resolvedModule) {
                     resolvedModules.push(result.resolvedModule);
                 } else {
                     // Add custom fallback logic here if necessary (e.g., searching node_modules explicitly)
                     // connection.console.log(`[resolveModuleNames] Failed to resolve '${moduleName}' from '${containingFile}'`);
                     resolvedModules.push(undefined);
                 }
             }
             return resolvedModules;
         },
    };
    return ts.createLanguageService(host);
}

// Helper: Converts PascalCase or camelCase to kebab-case
function toKebabCase(str: string): string {
    if (!str) return '';
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2') // CamelCase to kebab-case
        .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2') // Handle adjacent caps like HTMLElement
        .toLowerCase();
}

// Scans workspace using the Language Service for Aurelia components/attributes
// TODO: Optimize - avoid rescanning unchanged files.
function scanWorkspaceForAureliaComponents() {
    if (!languageService || !workspaceRoot) {
        connection.console.warn('[scanWorkspace] Language service or workspace root not available.');
        return;
    }
    connection.console.log(`[scanWorkspace] Scanning project for Aurelia components/attributes using Language Service...`);
  const foundComponents = new Map<string, { uri: string, type: 'element' | 'attribute', name: string, bindables?: string[] }>();
    const program = languageService.getProgram();
    if (!program) {
        connection.console.warn('[scanWorkspace] Could not get program from language service.');
        return;
    }

    const sourceFiles = program.getSourceFiles();
    connection.console.log(`[scanWorkspace] Analyzing ${sourceFiles.length} source files...`);

    for (const sourceFile of sourceFiles) {
    // Skip declaration files and files outside the workspace
    const isDeclaration = sourceFile.isDeclarationFile;
    // +++ Normalize paths before comparison +++
    const normalizedFileName = sourceFile.fileName.replace(/\\/g, '/');
    const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, '/');
    // Ensure workspace root path ends with a slash for accurate startsWith check
    const normalizedWorkspaceRootWithSlash = normalizedWorkspaceRoot.endsWith('/')
      ? normalizedWorkspaceRoot
      : normalizedWorkspaceRoot + '/';
    const isInWorkspace = normalizedFileName.startsWith(normalizedWorkspaceRootWithSlash);
    // +++++++++++++++++++++++++++++++++++++++

    if (isDeclaration || !isInWorkspace) {
      // +++ Log skipped files +++
      if (isDeclaration) {
        log('debug', `[scanWorkspace] Skipping declaration file: ${normalizedFileName}`);
      }
      if (!isInWorkspace) {
        // Log with normalized paths for clarity
        log('debug', `[scanWorkspace] Skipping file outside workspace (${normalizedWorkspaceRootWithSlash}): ${normalizedFileName}`);
      }
      // +++++++++++++++++++++++
            continue;
        }
    // Log file being analyzed (use normalized name)
    log('debug', `[scanWorkspace] Analyzing file: ${normalizedFileName}`);

        ts.forEachChild(sourceFile, node => {
            if (ts.isClassDeclaration(node) && node.name) {
                const className = node.name.getText(sourceFile);
        log('debug', `  - Found class: ${className}`);
                const decorators = ts.getDecorators(node);
        let isExplicitlyDecorated = false;
        let foundElementType: 'element' | 'attribute' | undefined = undefined;

                if (decorators && decorators.length > 0) {
          log('debug', `    - Found ${decorators.length} decorator(s)`);
                    for (const decorator of decorators) {
                        const decoratorExpr = decorator.expression;
                        let decoratorName: string | undefined = undefined;
                        let firstArg: string | undefined = undefined;

                        if (ts.isCallExpression(decoratorExpr)) {
                            if (ts.isIdentifier(decoratorExpr.expression)) {
                                decoratorName = decoratorExpr.expression.getText(sourceFile);
                            }
                            if (decoratorExpr.arguments.length > 0 && ts.isStringLiteral(decoratorExpr.arguments[0])) {
                                firstArg = decoratorExpr.arguments[0].text;
                            }
                        } else if (ts.isIdentifier(decoratorExpr)) {
                            decoratorName = decoratorExpr.getText(sourceFile);
                        }
            // +++ Log decorator details +++
            log('debug', `      - Decorator Name: ${decoratorName}, First Arg: ${firstArg}`);

                        const fileUri = URI.file(sourceFile.fileName).toString();

                        if (decoratorName === 'customElement') {
              isExplicitlyDecorated = true;
              foundElementType = 'element';
                            const elementName = firstArg ?? toKebabCase(className);
              log('debug', `        - Potential Element Name: ${elementName} (from ${firstArg ? 'arg' : 'class'})`);
                            if (elementName && !foundComponents.has(elementName)) {
                // +++ Get and store bindables +++
                const bindables = getBindablePropertiesFromClassNode(node, sourceFile);
                foundComponents.set(elementName, { uri: fileUri, type: 'element', name: elementName, bindables: bindables });
                log('info', `[scanWorkspace] --> Found Element: ${elementName} (Bindables: ${bindables.join(', ')}) in ${sourceFile.fileName}`);
                // +++++++++++++++++++++++++++++++
              }
              break;
            }
                        if (decoratorName === 'customAttribute') {
              isExplicitlyDecorated = true;
              foundElementType = 'attribute'; // Mark as attribute
                            const attributeName = firstArg ?? toKebabCase(className);
              log('debug', `        - Potential Attribute Name: ${attributeName} (from ${firstArg ? 'arg' : 'class'})`);
                             if (attributeName && !foundComponents.has(attributeName)) {
                foundComponents.set(attributeName, { uri: fileUri, type: 'attribute', name: attributeName }); // No bindables stored for attributes
                log('info', `[scanWorkspace] --> Found Attribute: ${attributeName} in ${sourceFile.fileName}`);
              }
              break;
            }
          }
        }

        // Implicit Element Check (Only if not explicitly decorated as element OR attribute)
        if (!isExplicitlyDecorated) {
          log('debug', `    - No explicit Au decorator found for ${className}, checking for implicit HTML pair.`);
          const tsFilePath = sourceFile.fileName;
          const dirName = path.dirname(tsFilePath);
          const baseName = path.basename(tsFilePath, ".ts"); // Get base name without .ts
          const expectedHtmlFileName = `${toKebabCase(baseName)}.html`;
          const expectedHtmlPath = path.join(dirName, expectedHtmlFileName);

          if (fileExistsOnDisk(expectedHtmlPath)) {
            log('debug', `      - Found corresponding HTML file: ${expectedHtmlPath}`);
            const implicitElementName = toKebabCase(className);
            if (implicitElementName && !foundComponents.has(implicitElementName)) {
              // +++ Get and store bindables +++
              const fileUri = URI.file(sourceFile.fileName).toString();
              const bindables = getBindablePropertiesFromClassNode(node, sourceFile);
              foundComponents.set(implicitElementName, { uri: fileUri, type: 'element', name: implicitElementName, bindables: bindables });
              log('info', `[scanWorkspace] --> Found Implicit Element: ${implicitElementName} (Bindables: ${bindables.join(', ')}) (via class ${className} + ${expectedHtmlFileName})`);
              // ---------------------------
            }
          } else {
            log('debug', `      - No corresponding HTML file found at ${expectedHtmlPath}`);
          }
        }
        // ++++++++++++++++++++++++++++
            }
        });
    }

    aureliaProjectComponents = foundComponents;
    connection.console.log(`[scanWorkspace] Scan complete. Found ${aureliaProjectComponents.size} potential components/attributes.`);

    // // Dummy data for testing:
    // aureliaProjectComponents.clear();
    // aureliaProjectComponents.set('my-component', { uri: 'file:///dummy/my-component.ts', type: 'element', name: 'my-component' });
    // aureliaProjectComponents.set('my-attribute', { uri: 'file:///dummy/my-attribute.ts', type: 'attribute', name: 'my-attribute' });
    // connection.console.log(`[scanWorkspace] Using dummy data: ${aureliaProjectComponents.size} components/attributes.`);
}

// Helper to process a single TS file for components/attributes
// Returns true if the map was potentially changed, false otherwise
function updateComponentInfoForFile(fileUri: string): boolean {
    if (!languageService || !workspaceRoot) return false;
    const program = languageService.getProgram();
    if (!program) return false;
    const sourceFile = program.getSourceFile(URI.parse(fileUri).fsPath);
    if (!sourceFile || sourceFile.isDeclarationFile || !sourceFile.fileName.startsWith(workspaceRoot)) {
        return false; // Not a relevant source file
    }

    let componentFound = false;
    let mapChanged = false;
    const filePath = URI.parse(fileUri).fsPath;

    // Check existing entries for this file URI to see if we need to remove old ones first
    let existingComponentName: string | undefined = undefined;
    for (const [name, info] of aureliaProjectComponents.entries()) {
        if (info.uri === fileUri) {
            existingComponentName = name;
            break;
        }
    }

    ts.forEachChild(sourceFile, node => {
        if (ts.isClassDeclaration(node) && node.name) {
            const className = node.name.getText(sourceFile);
            const decorators = ts.getDecorators(node);

            if (decorators && decorators.length > 0) {
                for (const decorator of decorators) {
                    // ... (logic to get decoratorName and firstArg - same as in full scan)
                    const decoratorExpr = decorator.expression;
                    let decoratorName: string | undefined = undefined;
                    let firstArg: string | undefined = undefined;
                    if (ts.isCallExpression(decoratorExpr)) {
                        if (ts.isIdentifier(decoratorExpr.expression)) {
                            decoratorName = decoratorExpr.expression.getText(sourceFile);
                        }
                        if (decoratorExpr.arguments.length > 0 && ts.isStringLiteral(decoratorExpr.arguments[0])) {
                            firstArg = decoratorExpr.arguments[0].text;
                        }
                    } else if (ts.isIdentifier(decoratorExpr)) {
                        decoratorName = decoratorExpr.getText(sourceFile);
                    }

                    // Check for @customElement
                    if (decoratorName === 'customElement') {
                        const elementName = firstArg ?? toKebabCase(className);
                        if (elementName) {
                             componentFound = true;
                             // Add/update map
                             if (existingComponentName !== elementName || !aureliaProjectComponents.has(elementName)) {
                                if (existingComponentName) aureliaProjectComponents.delete(existingComponentName); // Remove old if name changed
                aureliaProjectComponents.set(elementName, { uri: fileUri, type: 'element', name: elementName, bindables: getBindablePropertiesFromClassNode(node, sourceFile) });
                log('info', `[File Watch] Updated/Added Element: ${elementName} (Bindables: ${getBindablePropertiesFromClassNode(node, sourceFile).join(', ')}) from ${filePath}`);
                                mapChanged = true;
                             }
                        }
                        break;
                    }
                    // Check for @customAttribute
                    if (decoratorName === 'customAttribute') {
                        const attributeName = firstArg ?? toKebabCase(className);
                         if (attributeName) {
                             componentFound = true;
                            if (existingComponentName !== attributeName || !aureliaProjectComponents.has(attributeName)) {
                                if (existingComponentName) aureliaProjectComponents.delete(existingComponentName);
                                aureliaProjectComponents.set(attributeName, { uri: fileUri, type: 'attribute', name: attributeName });
                log('info', `[File Watch] Updated/Added Attribute: ${attributeName} from ${filePath}`);
                                mapChanged = true;
                            }
                         }
                         break;
                    }
                }
            }
        }
    });

    // If no component was found in the file, but we had an old entry, remove it
    if (!componentFound && existingComponentName) {
         aureliaProjectComponents.delete(existingComponentName);
         connection.console.log(`[File Watch] Removed component/attribute ${existingComponentName} associated with ${filePath}`);
         mapChanged = true;
    }

    return mapChanged;
}


// --- LSP Event Handlers ---

connection.onInitialize((params: InitializeParams) => {
    // Keep only the FIRST correctly structured onInitialize handler
  workspaceRoot = params.rootUri ? URI.parse(params.rootUri).fsPath : params.rootPath || process.cwd();
    strictMode = params.initializationOptions?.strictMode ?? false;

    languageService = createLanguageServiceInstance(workspaceRoot);
    scanWorkspaceForAureliaComponents(); // Keep initial full scan
  // +++ Log map size after initial scan +++
  log('info', `[Initialize] Initial scan complete. Found ${aureliaProjectComponents.size} components/attributes.`);
  // ++++++++++++++++++++++++++++++++++++++++
  connection.console.log(`[Initialize] Aurelia language server initializing in ${workspaceRoot}.`); // Removed StrictMode here

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false, 
                triggerCharacters: ['.', '{', '(', '=', '<', ' ']
            },
            definitionProvider: true,
            hoverProvider: true,
            signatureHelpProvider: { triggerCharacters: ['(', ','] },
            codeActionProvider: true,
            documentFormattingProvider: true,
            semanticTokensProvider: {
                legend: legend,
                full: true,
            },
            workspace: {
                workspaceFolders: {
                    supported: true,
                    changeNotifications: true // Request file change notifications
                }
            },
            renameProvider: { 
                prepareProvider: true
            },
            referencesProvider: true // <<< ADDED
        },
    };
  return result;
});


documents.onDidChangeContent((change) => {
    const uri = change.document.uri;
    const fsPath = URI.parse(uri).fsPath;
  const htmlUriString = URI.parse(uri).toString(); // Use normalized URI string

    if (uri.endsWith('.html')) {
    updateVirtualFile(htmlUriString, change.document.getText()); // Pass normalized
    } else if (uri.endsWith('.ts')) {
        let isViewModelForOpenDoc = false;
    for (const [htmlUriKey, docInfo] of aureliaDocuments.entries()) {
            if (docInfo.vmFsPath === fsPath) {
        const htmlDoc = documents.get(htmlUriKey); // Use the key from the map
                if (htmlDoc) {
          log('info', `[onDidChangeContent] ViewModel ${uri} changed, updating virtual file for ${htmlUriKey}`);
          updateVirtualFile(htmlDoc.uri, htmlDoc.getText()); // htmlDoc.uri should already be normalized string
                    isViewModelForOpenDoc = true;
                }
        break; // Assuming one VM per HTML for now
            }
        }
    }
});

documents.onDidClose(event => {
  const htmlUriString = event.document.uri; // URI from event is already string
  if (htmlUriString.endsWith('.html')) {
    const docInfo = aureliaDocuments.get(htmlUriString);
        if (docInfo) {
            virtualFiles.delete(docInfo.virtualUri);
      aureliaDocuments.delete(htmlUriString);
      connection.sendDiagnostics({ uri: htmlUriString, diagnostics: [] });
      log('info', `[onDidClose] Cleaned up resources for ${htmlUriString}`);
     }
  }
});

connection.onDidChangeConfiguration((_params) => {
    // Handle configuration changes if needed
    // Recreate LS or update settings
    // For now, just log
    connection.console.log("[onDidChangeConfiguration] Configuration changed (re-initialization might be needed for some settings).");
});

// Handle watched file changes for components (with debouncing)
connection.onDidChangeWatchedFiles((params) => {
    connection.console.log('[onDidChangeWatchedFiles] Received file changes.');
    let changedUrisForProcessing = false;

    for (const change of params.changes) {
        const fileUri = change.uri;
        if (!fileUri.endsWith('.ts') || fileUri.includes('node_modules')) {
            continue;
        }

        connection.console.log(`  - Change Type: ${change.type}, File: ${fileUri}`);

        if (change.type === FileChangeType.Deleted) {
            // Remove immediately from our map if it exists
            let removed = false;
            for (const [name, info] of aureliaProjectComponents.entries()) {
                if (info.uri === fileUri) {
                    aureliaProjectComponents.delete(name);
                    connection.console.log(`  -> Removed component/attribute ${name} from cache.`);
                    removed = true;
                    // Don't break, might be registered under multiple names? (unlikely but possible)
                }
            }
            // Remove from processing queue if it was pending
            componentUpdateQueue.delete(fileUri);
        } else {
            // Created or Changed: Add to queue for debounced processing
            componentUpdateQueue.add(fileUri);
            changedUrisForProcessing = true;
        }
    }

    // If new files were added/changed, schedule processing
    if (changedUrisForProcessing) {
        // Clear existing timer if any
        if (componentUpdateTimer) {
            clearTimeout(componentUpdateTimer);
        }
        // Schedule processing after debounce period
        componentUpdateTimer = setTimeout(() => {
            connection.console.log(`[File Watch Debounce] Processing ${componentUpdateQueue.size} queued file changes...`);
            const urisToProcess = new Set(componentUpdateQueue); // Copy queue
            componentUpdateQueue.clear(); // Clear original queue

            let needsFullRescanOnError = false;
            urisToProcess.forEach(uri => {
                try {
                    updateComponentInfoForFile(uri);
                } catch (e) {
                    connection.console.error(`  -> Error processing queued file change ${uri}: ${e}`);
                    // Decide if a full rescan is needed on error
                    needsFullRescanOnError = true;
                }
            });

            if (needsFullRescanOnError) {
                connection.console.warn('[File Watch Debounce] Triggering full rescan due to errors during processing.');
                scanWorkspaceForAureliaComponents(); // Fallback to full scan on error
            }

            componentUpdateTimer = undefined; // Clear timer reference
        }, COMPONENT_UPDATE_DEBOUNCE_MS);
    }
});

// --- Completion ---
connection.onCompletion((params: CompletionParams): CompletionItem[] | undefined => {
  const htmlUriString = params.textDocument.uri; // Already a string
  const document = documents.get(htmlUriString);
  if (!document || !htmlUriString.endsWith('.html')) return undefined;

    const offset = document.offsetAt(params.position);
  const docInfo = aureliaDocuments.get(htmlUriString);
  let activeMapping: DetailedMapping | undefined;

    // Try to find if we are *inside* an expression first
    if (docInfo) {
    // +++ Log comparison details +++
    log('debug', `[onCompletion] Checking offset ${offset} against ${docInfo.mappings.length} mappings.`);
        for (const mapping of docInfo.mappings) {
      const mapStart = mapping.htmlExpressionLocation.startOffset;
      const mapEnd = mapping.htmlExpressionLocation.endOffset;
      log('debug', `  - Comparing with mapping (type: ${mapping.type}, range: [${mapStart}-${mapEnd}])`);
      // Check if offset is within the bounds [start, end]
      if (mapStart <= offset && offset <= mapEnd) {
        log('debug', `    - Offset ${offset} IS within [${mapStart}-${mapEnd}]. Setting active mapping.`);
                  activeMapping = mapping;
                  break;
             }
    }
  }

    // --- Branch 1: Completion OUTSIDE an Aurelia expression (HTML structure) ---
  if (!activeMapping) {
        const text = document.getText();
        const lookBehind = 100;
        const fragmentStartOffset = Math.max(0, offset - lookBehind);
        const fragment = text.substring(fragmentStartOffset, offset);
        // Get text *after* cursor for attribute filtering if needed (small amount)
        const lookAhead = 50;
        const textAfterFragment = text.substring(offset, Math.min(text.length, offset + lookAhead));
        const triggerChar = params.context?.triggerCharacter;
        const charBeforeCursor = offset > 0 ? text[offset - 1] : '';

        let htmlCompletions: CompletionItem[] = [];
        connection.console.log(`[onCompletion] HTML Context Analysis: Trigger='${triggerChar}', charBefore='${charBeforeCursor}'`);

        // === Improved Context Detection using parse5 ===
        try {
            // Use context element 'body' for fragment parsing validity
            const parsedFragment = parse5.parseFragment(fragment, { sourceCodeLocationInfo: true });
            const nodes = parsedFragment.childNodes;
            const relativeOffset = offset - fragmentStartOffset;
            let targetNode: Node | undefined;
            let parentElement: Element | undefined;
            let isInsideTagName = false;
            let isCompletingTagName = false;
            let isInsideAttributeName = false;
            let isCompletingAttributeName = false;
            let isInsideOpeningTagSpace = false;
            let currentTagName: string | undefined = undefined;
            let currentAttributeName: string | undefined = undefined; // Store partially typed attribute

            function findContext(node: Node, parent: Element | undefined) {
                if (!node.sourceCodeLocation) return;
                const loc = node.sourceCodeLocation;
                if (loc.startOffset <= relativeOffset && relativeOffset <= loc.endOffset) {
                    targetNode = node;
                    parentElement = parent;

                    if (node.nodeName !== '#text' && node.nodeName !== '#comment' && 'tagName' in node && 'startTag' in loc && loc.startTag) {
                        const elementNode = node as Element;
                        const startTag = loc.startTag;
                        const tagNameLength = elementNode.tagName.length;
                        const tagNameStart = startTag.startOffset + 1;
                        const tagNameEnd = tagNameStart + tagNameLength;

                        // Cursor right after '<' or within tag name
                        if (relativeOffset >= tagNameStart && relativeOffset <= tagNameEnd) {
                            isInsideTagName = true;
                            // If triggered by '< ', likely completing tag name
                            if (triggerChar === '<' || charBeforeCursor === '<' || text[tagNameStart - 1] === '<') {
                                isCompletingTagName = true;
                            }
                        }
                        // Cursor after tag name but before tag end '>'
                        else if (relativeOffset > tagNameEnd && relativeOffset <= startTag.endOffset) {
                            let isInAttribute = false;
                            if (loc.attrs) {
                                for (const attrName in loc.attrs) {
                                    const attrLoc = loc.attrs[attrName];
                                    if (relativeOffset >= attrLoc.startOffset && relativeOffset <= attrLoc.endOffset) {
                                        isInAttribute = true;
                                        // Check if inside the attribute name part
                                        if (relativeOffset <= attrLoc.startOffset + attrName.length) {
                                            isInsideAttributeName = true;
                                        }
                                        // TODO: Add check for inside attribute value later if needed
                                        break; // Found the attribute containing the cursor
                                    }
                                }
                            }
                            if (!isInAttribute) {
                                // Not in any specific attribute's range, must be in the space between tag/attributes
                                isInsideOpeningTagSpace = true;
                            }
                        }
                    }

                    // Recurse if possible
                    if ('childNodes' in node && (node as Element).childNodes.length > 0) {
                        (node as Element).childNodes.forEach(child => findContext(child, node as Element));
                    }
                }
            }
            nodes.forEach(node => findContext(node, undefined));

            // --- Context-Specific Completion Logic ---
            let provideElementCompletions = false;
            let provideAttributeCompletions = false;
      currentTagName = parentElement?.tagName; // Assign to existing variable

      log('debug', `[onCompletion] HTML Context Detection: isInsideTagName=${isInsideTagName}, isInsideOpeningTagSpace=${isInsideOpeningTagSpace}, isInsideAttributeName=${isInsideAttributeName}, charBeforeCursor='${charBeforeCursor}'`);

            if (charBeforeCursor === '<' || isInsideTagName) {
                provideElementCompletions = true;
            } else if (isInsideOpeningTagSpace || isInsideAttributeName) {
                provideAttributeCompletions = true;
      } else if (targetNode?.nodeName === '#text' && triggerChar === '<') {
                provideElementCompletions = true;
      }

      // +++ MOVE Dot trigger check BEFORE the fallback check +++
      else if (triggerChar === '.') { 
        const textBeforeOffset = document.getText(LSPRange.create(Position.create(0,0), params.position));
        const lastTagOpenMatch = textBeforeOffset.match(/<([a-zA-Z0-9-]+)[^>]*$/);
        const tagNameFromRegex = lastTagOpenMatch ? lastTagOpenMatch[1] : undefined;
        log('debug', `[onCompletion] Dot trigger detected. Preceding tag found via regex: ${tagNameFromRegex}`);
        
        if (tagNameFromRegex) { 
          const componentInfo = aureliaProjectComponents.get(tagNameFromRegex);
          if (componentInfo?.type === 'element' && componentInfo.bindables && Array.isArray(componentInfo.bindables)) {
            const textEndingBeforeDot = document.getText(LSPRange.create(Position.create(0,0), document.positionAt(offset-1)));
            const wordMatch = textEndingBeforeDot.match(/([a-zA-Z0-9_-]+)$/);
            const wordBeforeDot = wordMatch ? wordMatch[1] : '';
            log('debug', `  - Word before dot: '${wordBeforeDot}'`);

            if (wordBeforeDot && componentInfo.bindables.includes(wordBeforeDot)) {
              log('debug', `  - Word matches bindable: ${wordBeforeDot}. Providing suffix completions.`);
              AURELIA_BINDING_SUFFIXES.forEach(suffix => {
                if (suffix !== '.ref') { 
                  htmlCompletions.push({
                    label: `${wordBeforeDot}${suffix}`,
                    kind: CompletionItemKind.Event,
                    insertText: suffix.substring(1), // Insert only the part after the dot
                    insertTextFormat: InsertTextFormat.PlainText,
                    detail: `Bind ${suffix} on property ${wordBeforeDot}`,
                    sortText: `0_bindable_${wordBeforeDot}${suffix}`
                  });
                }
              });
              const distinctMap = new Map<string, CompletionItem>();
              htmlCompletions.forEach(item => { if (!distinctMap.has(item.label)) { distinctMap.set(item.label, item); } });
              const distinctCompletions = Array.from(distinctMap.values());
              log('debug', `[onCompletion] HTML Context (Dot Trigger): Returning ${distinctCompletions.length} distinct completions.`);
              return distinctCompletions;
            }
          }
        }
        // If dot trigger handled or failed, return htmlCompletions (might be empty)
        // Avoid falling through to the generic fallback below
        log('debug', `[onCompletion] Dot trigger logic finished. Returning ${htmlCompletions.length} items.`);
        return htmlCompletions.length > 0 ? htmlCompletions : undefined;
      }
      // +++ THEN check fallback for attribute/bindable context (Space or Ctrl+Space) +++
      else if (!provideAttributeCompletions && !provideElementCompletions && (charBeforeCursor === ' ' || triggerChar === undefined)) { 
        const textBeforeOffset = document.getText(LSPRange.create(Position.create(0,0), params.position));
        const tagMatch = textBeforeOffset.match(/<([a-zA-Z0-9-]+)\s*$/); 
        
        if (tagMatch) {
          const tagNameFromRegex = tagMatch[1];
          log('debug', `[onCompletion] HTML Context: Triggering attribute completions based on fallback check (Trigger: ${triggerChar}, CharBefore: ${charBeforeCursor}). Tag found: ${tagNameFromRegex}`);
          provideAttributeCompletions = true;
          currentTagName = tagNameFromRegex; 
        } else {
          log('debug', '[onCompletion] HTML Context: Fallback check did not find preceding tag.');
        }
      }

      log('debug', `[onCompletion] HTML Context Flags: provideElements=${provideElementCompletions}, provideAttributes=${provideAttributeCompletions}, currentTagName=${currentTagName}`);
      // +++++++++++++++++++++++++++++++++++++++

            // --- Generate Completions Based on Context ---
            if (provideElementCompletions) {
        // +++ Log Component Map State +++
        log('debug', `[onCompletion] Providing Element completions. Project components count: ${aureliaProjectComponents.size}`);
        // ++++++++++++++++++++++++++++++++
                // Add Aurelia Custom Elements
                aureliaProjectComponents.forEach((info) => {
                    if (info.type === 'element') {
            // +++ Log Adding Element Completion +++
            log('debug', `  - Adding element completion: ${info.name}`);
            // ++++++++++++++++++++++++++++++++++++++
                        htmlCompletions.push({ label: info.name, kind: CompletionItemKind.Class, detail: `Au Element (${path.basename(URI.parse(info.uri).fsPath)})` });
                    }
                });
            }

            if (provideAttributeCompletions) {
                // Add Aurelia Custom Attributes
                aureliaProjectComponents.forEach((info) => {
                    if (info.type === 'attribute') {
                        htmlCompletions.push({
                            label: info.name,
                            kind: CompletionItemKind.Property,
                            insertText: `${info.name}="$1"`,
                            insertTextFormat: InsertTextFormat.Snippet,
                            detail: `Au Attribute (${path.basename(URI.parse(info.uri).fsPath)})`,
                        });
                        // Add bindings for the attribute
                        AURELIA_BINDING_SUFFIXES.forEach(suffix => {
                            if (suffix !== '.ref') {
                                htmlCompletions.push({
                                    label: `${info.name}${suffix}`,
                                    kind: CompletionItemKind.Event,
                                    insertText: `${info.name}${suffix}="\${1:expression}"`,
                                    insertTextFormat: InsertTextFormat.Snippet,
                                    detail: `Bind ${suffix} on ${info.name}`,
                                });
                            }
                        });
                    }
                });
                // Add Aurelia Template Controllers
                AURELIA_TEMPLATE_CONTROLLERS.forEach(controller => {
                    htmlCompletions.push({
                        label: controller,
                        kind: CompletionItemKind.Struct,
                        insertText: `${controller}="\${1:expression}"`,
                        insertTextFormat: InsertTextFormat.Snippet,
                        detail: `Aurelia Template Controller`,
                    });
                });

        // Add Aurelia Template Controllers (High Priority)
        AURELIA_TEMPLATE_CONTROLLERS.forEach(controller => {
          htmlCompletions.push({
            label: controller,
            kind: CompletionItemKind.Struct,
            insertText: `${controller}="\${1:expression}"`,
            insertTextFormat: InsertTextFormat.Snippet,
            detail: `Aurelia Template Controller`,
            sortText: `0_controller_${controller}` // High priority
          });
        });

        // +++ Add Bindable Property Completions (Assuming type def is fixed) +++
        if (currentTagName) {
          const componentInfo = aureliaProjectComponents.get(currentTagName);
          // Check if it's a known element AND has bindables stored
          if (componentInfo?.type === 'element' && componentInfo.bindables && Array.isArray(componentInfo.bindables)) {
            log('debug', `[onCompletion] Found element <${currentTagName}> with bindables: ${componentInfo.bindables.join(', ')}`);
            componentInfo.bindables.forEach(bindableName => {
              // Suggest the bindable property name itself
              htmlCompletions.push({
                label: bindableName,
                kind: CompletionItemKind.Property, // Bindable property
                insertText: `${bindableName}="$1"`, // Basic attribute snippet
                insertTextFormat: InsertTextFormat.Snippet,
                detail: `Bindable property for <${currentTagName}>`,
                sortText: `0_bindable_${bindableName}` // High priority
              });
              // Suggest common binding commands for the bindable
              AURELIA_BINDING_SUFFIXES.forEach(suffix => {
                // Don't suggest .ref for bindables typically
                if (suffix !== '.ref') {
                  htmlCompletions.push({
                    label: `${bindableName}${suffix}`,
                    kind: CompletionItemKind.Event, // Or Property/Function?
                    insertText: `${bindableName}${suffix}="\${1:expression}"`,
                    insertTextFormat: InsertTextFormat.Snippet,
                    detail: `Bind ${suffix} on ${bindableName}`,
                    sortText: `0_bindable_${bindableName}${suffix}` // High priority
                  });
                }
              });
            });
          }
        }
      }

      // +++ Add specific check for dot after potential bindable +++
      // --- Remove check for pre-defined currentTagName --- 
      // else if (triggerChar === '.' && currentTagName) { 
      else if (triggerChar === '.') {
        // --- Find preceding tag name independently --- 
        const textBeforeOffset = document.getText(LSPRange.create(Position.create(0, 0), params.position));
        // Regex: Find the last opening tag bracket before the current position
        const lastTagOpenMatch = textBeforeOffset.match(/<([a-zA-Z0-9-]+)[^>]*$/);
        const tagNameFromRegex = lastTagOpenMatch ? lastTagOpenMatch[1] : undefined;
        log('debug', `[onCompletion] Dot trigger detected. Preceding tag found via regex: ${tagNameFromRegex}`);
        // -------------------------------------------

        if (tagNameFromRegex) { // Only proceed if we found a preceding tag
          const componentInfo = aureliaProjectComponents.get(tagNameFromRegex);
          if (componentInfo?.type === 'element' && componentInfo.bindables && Array.isArray(componentInfo.bindables)) {
            // Get the word immediately before the dot
            // +++ Operate on text BEFORE the dot +++
            const textEndingBeforeDot = document.getText(LSPRange.create(Position.create(0, 0), document.positionAt(offset - 1)));
            const wordMatch = textEndingBeforeDot.match(/([a-zA-Z0-9_-]+)$/);
            const wordBeforeDot = wordMatch ? wordMatch[1] : '';
            // +++++++++++++++++++++++++++++++++++++
            log('debug', `  - Word before dot: '${wordBeforeDot}'`);

            if (wordBeforeDot && componentInfo.bindables.includes(wordBeforeDot)) {
              log('debug', `  - Word matches bindable: ${wordBeforeDot}. Providing suffix completions.`);
              // Provide suffix completions
              AURELIA_BINDING_SUFFIXES.forEach(suffix => {
                if (suffix !== '.ref') {
                  htmlCompletions.push({
                    label: `${wordBeforeDot}${suffix}`,
                    kind: CompletionItemKind.Event,
                    insertText: suffix.substring(1), // Insert only the part after the dot
                    insertTextFormat: InsertTextFormat.PlainText,
                    detail: `Bind ${suffix} on property ${wordBeforeDot}`,
                    sortText: `0_bindable_${wordBeforeDot}${suffix}`
                  });
                }
              });
              // +++ Return the generated completions +++
              // Return distinct completions to avoid duplicates if other logic runs
              const distinctMap = new Map<string, CompletionItem>();
              htmlCompletions.forEach(item => { if (!distinctMap.has(item.label)) { distinctMap.set(item.label, item); } });
              const distinctCompletions = Array.from(distinctMap.values());
              log('debug', `[onCompletion] HTML Context (Dot Trigger): Returning ${distinctCompletions.length} distinct completions.`);
              return distinctCompletions;
              // +++++++++++++++++++++++++++++++++++++++
            }
          }
        }
      }
      // +++++++++++++++++++++++++++++++++++++++++++++++++++++++

        } catch (parseError) {
            connection.console.warn(`[onCompletion] HTML Context: Error parsing fragment: ${parseError}. Falling back to basic triggers.`);
            // --- Fallback Logic (Simplified) ---
            if (triggerChar === '<' || charBeforeCursor === '<') {
                 aureliaProjectComponents.forEach((info) => {
                    if (info.type === 'element') { htmlCompletions.push({ label: info.name, kind: CompletionItemKind.Class, detail: `Au Element (${path.basename(URI.parse(info.uri).fsPath)})` }); }
                });
            } else if (triggerChar === ' ') {
                 const textBefore = text.substring(0, offset);
                 const tagMatch = textBefore.match(/<([a-zA-Z0-9-]+)\s*$/);
                 if (tagMatch) {
                     // Remove duplicate declaration - currentTagName is already defined in the outer scope
          // const tagName = tagMatch[1]; // << REMOVED
                     const matchedTagName = tagMatch[1]; // Use a different name to avoid conflict
          // currentTagName = matchedTagName; // Assign to the outer scope variable if needed, or just use matchedTagName <-- REMOVED THIS LINE
                     // ... (attribute completion logic, using matchedTagName)
                     aureliaProjectComponents.forEach((info) => {
                         if (info.type === 'attribute') {
                            htmlCompletions.push({ label: info.name, kind: CompletionItemKind.Property, insertText: `${info.name}="$1"`, insertTextFormat: InsertTextFormat.Snippet, detail: `Au Attribute (${path.basename(URI.parse(info.uri).fsPath)})` });
                            AURELIA_BINDING_SUFFIXES.forEach(suffix => { if (suffix !== '.ref') { htmlCompletions.push({ label: `${info.name}${suffix}`, kind: CompletionItemKind.Event, insertText: `${info.name}${suffix}="\${1:expression}"`, insertTextFormat: InsertTextFormat.Snippet, detail: `Bind ${suffix} on ${info.name}` }); } });
                         }
                     });
                     AURELIA_TEMPLATE_CONTROLLERS.forEach(controller => { htmlCompletions.push({ label: controller, kind: CompletionItemKind.Struct, insertText: `${controller}="\${1:expression}"`, insertTextFormat: InsertTextFormat.Snippet, detail: `Aurelia Template Controller` }); });
                 }
            }
            // End of fallback logic within catch
        }
        // ================================================

        // Return distinct completions from HTML context analysis
        if (htmlCompletions.length > 0) {
             const distinctMap = new Map<string, CompletionItem>();
             htmlCompletions.forEach(item => {
                 if (!distinctMap.has(item.label)) {
                     distinctMap.set(item.label, item);
                 }
             });
             const distinctCompletions = Array.from(distinctMap.values());
             connection.console.log(`[onCompletion] HTML Context: Returning ${distinctCompletions.length} distinct completions.`);
             return distinctCompletions;
        }
    }
    // --- End Branch 1 ---

    // --- Branch 2: Completion INSIDE an Aurelia expression --- 
    if (docInfo && activeMapping) {
        // ... (existing expression completion logic, ensure 'result' is defined and returned)
        let result: CompletionItem[] = []; // Placeholder for expression results variable
        const relativeHtmlOffset = offset - activeMapping.htmlExpressionLocation.startOffset;
        let virtualCompletionOffset: number;
        if (activeMapping.wasThisPrepended) {
            const baseVirtualOffset = activeMapping.virtualValueRange.start + 6;
            virtualCompletionOffset = baseVirtualOffset + relativeHtmlOffset;
            virtualCompletionOffset = Math.max(baseVirtualOffset, Math.min(virtualCompletionOffset, activeMapping.virtualValueRange.end));
        } else {
            virtualCompletionOffset = activeMapping.virtualValueRange.start + relativeHtmlOffset;
            virtualCompletionOffset = Math.max(activeMapping.virtualValueRange.start, Math.min(virtualCompletionOffset, activeMapping.virtualValueRange.end));
        }
        if (offset === activeMapping.htmlExpressionLocation.endOffset + 1 && params.context?.triggerCharacter === '.') {
            virtualCompletionOffset = activeMapping.virtualValueRange.end;
        }
    // +++ Ensure correct virtual FILE PATH is passed +++
    // const virtualUriToUse = docInfo.virtualUri; // We need the fsPath for LS calls
    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    log('debug', `[onCompletion] Requesting completions for virtual file path: ${virtualFsPath} at offset ${virtualCompletionOffset}`);

    let completions: ts.WithMetadata<ts.CompletionInfo> | undefined;
    try {
      log('debug', `[onCompletion] Requesting completions for virtual file path: ${virtualFsPath} at offset ${virtualCompletionOffset}`);
      completions = languageService.getCompletionsAtPosition(
        virtualFsPath,
            virtualCompletionOffset,
            {
                includeCompletionsForModuleExports: false,
                includeCompletionsWithInsertText: true,
            }
        );
    } catch (error) {
      log('error', `[onCompletion] Error calling languageService.getCompletionsAtPosition: ${error}`);
      return undefined; // Exit early on error
    }

    if (!completions) { // Check if TS returned undefined/null
      log('debug', "[onCompletion] TS returned no completions object.");
      // Maybe return fallback completions here? For now, return undefined.
      return undefined;
    }

    // --- Process completions --- 
    let expressionCompletions: CompletionItem[] = []; // <<< RENAME variable
  const desiredKinds = [
    ts.ScriptElementKind.memberVariableElement, 
    ts.ScriptElementKind.memberFunctionElement, 
    ts.ScriptElementKind.memberGetAccessorElement,
    ts.ScriptElementKind.memberSetAccessorElement,
                ts.ScriptElementKind.keyword,
            ];
    expressionCompletions = completions.entries
                .filter(entry => {
        if (entry.name.startsWith('___expr_') || entry.name.startsWith('_this') || entry.name.startsWith('__filename') || entry.name.startsWith('__dirname')) return false;
                     if (entry.kind === ts.ScriptElementKind.moduleElement ||
                         entry.kind === ts.ScriptElementKind.classElement ||
                         entry.kind === ts.ScriptElementKind.interfaceElement ||
                         entry.kind === ts.ScriptElementKind.typeElement ||
                         entry.kind === ts.ScriptElementKind.enumElement) {
                         return false;
                     }
                      if (entry.kind === ts.ScriptElementKind.keyword && !['true', 'false', 'null', 'undefined'].includes(entry.name)) {
                          return false;
                      }
        return true;
                })
                .map((entry, index) => {
                    // +++ Get fresh member names for filtering +++
                    const currentMemberNames = getViewModelMemberNames(docInfo.vmClassName, docInfo.vmFsPath);
                    const isViewModelMember = currentMemberNames.includes(entry.name);
                    // +++++++++++++++++++++++++++++++++++++++++++

                    let sortPriority = '9'; // Default lowest priority
                    if (isViewModelMember) sortPriority = '0'; // Highest for VM members
        // else if (entry.kind === ts.ScriptElementKind.keyword) sortPriority = '1'; // <<< REMOVE OLD KEYWORD PRIORITY
        else sortPriority = '5'; // Standard priority for non-VM members (methods, properties)

        // +++ Add new Keyword Priority Check +++
        if (entry.kind === ts.ScriptElementKind.keyword) {
          sortPriority = '8'; // Lower priority for keywords
        }
        // ++++++++++++++++++++++++++++++++++++

                    const completionItem: CompletionItem = {
                        label: entry.name,
                        kind: mapCompletionKind(entry.kind),
                        insertText: entry.insertText ?? entry.name,
                        sortText: sortPriority + entry.sortText + index.toString().padStart(3, '0'),
                        detail: entry.kind,
                    };
                    return completionItem;
                });

    // Fallback logic for empty expression context
    // +++ Calculate textBeforeCursor here +++
            const originalHtmlText = document.getText(
                LSPRange.create(
                    document.positionAt(activeMapping.htmlExpressionLocation.startOffset),
                    document.positionAt(activeMapping.htmlExpressionLocation.endOffset)
                )
            );
    const relativeHtmlOffsetForFallback = offset - activeMapping.htmlExpressionLocation.startOffset;
    const textBeforeCursor = originalHtmlText.substring(0, relativeHtmlOffsetForFallback);
    // ++++++++++++++++++++++++++++++++++++++++
    // +++ Get fresh member names for fallback check +++
    const currentMemberNamesFallback = getViewModelMemberNames(docInfo.vmClassName, docInfo.vmFsPath);
    if (textBeforeCursor.trim() === '' && !expressionCompletions.some(item => currentMemberNamesFallback.includes(item.label))) {
      log("debug", "[onCompletion] Expression Context: Triggering fallback for empty expression (_this context).");
                currentMemberNamesFallback.forEach((memberName: string) => { // Added type annotation
                    if (!expressionCompletions.some(item => item.label === memberName)) {
                        expressionCompletions.push({
                            label: memberName,
                            kind: CompletionItemKind.Property,
                            insertText: memberName,
                            sortText: '0_fallback_' + memberName,
                            detail: '(ViewModel Member)',
                         });
                    }
                });
      expressionCompletions.sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
    }
    // ------------------------

    log('debug', `[onCompletion] Expression Context: Returning ${expressionCompletions.length} completion items.`);
    return expressionCompletions; // <<< RETURN renamed variable

  } // End of if (docInfo && activeMapping)

  // --- Fallback if neither branch returned (Should ideally not be reached if mapping was active) ---
  log('debug', `[onCompletion] Reached end of handler without returning completions for offset ${offset}.`);
    return undefined;
});

// Helper to map TS ScriptElementKind to LSP CompletionItemKind
function mapCompletionKind(kind: string): CompletionItemKind | undefined {
    switch (kind) {
        case ts.ScriptElementKind.memberVariableElement:
        case ts.ScriptElementKind.memberGetAccessorElement:
        case ts.ScriptElementKind.memberSetAccessorElement:
            return CompletionItemKind.Property;
        case ts.ScriptElementKind.memberFunctionElement:
            return CompletionItemKind.Method;
        case ts.ScriptElementKind.variableElement:
        case ts.ScriptElementKind.letElement:
        case ts.ScriptElementKind.constElement:
            return CompletionItemKind.Variable;
        case ts.ScriptElementKind.functionElement:
            return CompletionItemKind.Function;
        case ts.ScriptElementKind.keyword:
            return CompletionItemKind.Keyword;
        // Add mappings for other kinds if needed
        default:
            return undefined; // Or a default like CompletionItemKind.Text
    }
}


// --- Definition ---
connection.onDefinition(async (params: DefinitionParams): Promise<LocationLink[] | undefined> => {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const offset = document.offsetAt(params.position);

    // Find the active mapping
    let activeMapping: DetailedMapping | undefined;
    for (const mapping of docInfo.mappings) {
        // Cursor must be *strictly within* or at the start of the expression
        if (mapping.htmlExpressionLocation.startOffset <= offset && offset < mapping.htmlExpressionLocation.endOffset) {
             activeMapping = mapping;
             break;
         }
        // Allow definition at the very end character
         if (offset === mapping.htmlExpressionLocation.endOffset && mapping.htmlExpressionLocation.startOffset !== mapping.htmlExpressionLocation.endOffset) {
              activeMapping = mapping;
              break;
         }
    }


    if (!activeMapping) {
        connection.console.log(`[onDefinition] Offset ${offset} not within any mapped expression for definition.`);
        return undefined;
    }

    // Calculate position within the *original* HTML expression
    const relativeHtmlOffset = offset - activeMapping.htmlExpressionLocation.startOffset;

    // Calculate the corresponding offset in the *virtual* file's expression value
    let virtualDefinitionOffset: number;
    if (activeMapping.wasThisPrepended) {
         const baseVirtualOffset = activeMapping.virtualValueRange.start + 6; // After '_this.'
         virtualDefinitionOffset = baseVirtualOffset + relativeHtmlOffset;
         virtualDefinitionOffset = Math.max(baseVirtualOffset, Math.min(virtualDefinitionOffset, activeMapping.virtualValueRange.end));
        } else {
        virtualDefinitionOffset = activeMapping.virtualValueRange.start + relativeHtmlOffset;
         virtualDefinitionOffset = Math.max(activeMapping.virtualValueRange.start, Math.min(virtualDefinitionOffset, activeMapping.virtualValueRange.end));
    }

    connection.console.log(`[onDefinition] HTML Offset: ${offset}, Mapped Virtual Offset: ${virtualDefinitionOffset} in ${docInfo.virtualUri}`);

    // Get definition from TS Language Service
  // +++ Ensure fsPath is used +++
  const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
  log('debug', `[onDefinition] Getting definition for: ${virtualFsPath} at offset ${virtualDefinitionOffset}`);
  const definitionInfo = languageService.getDefinitionAndBoundSpan(virtualFsPath, virtualDefinitionOffset);

    if (!definitionInfo || !definitionInfo.definitions || definitionInfo.definitions.length === 0) {
        connection.console.log("[onDefinition] TS returned no definitions.");
        return undefined;
    }

    const locationLinks: LocationLink[] = [];
    const program = languageService.getProgram(); // Get program for source file access

    // --- Calculate Origin Span (HTML Highlighting) ---
    const originVirtualSpan = definitionInfo.textSpan; // The span TS identified in the virtual file (e.g., 'propertyName' in '_this.propertyName')
    const originVirtualStart = originVirtualSpan.start;
    const originVirtualLength = originVirtualSpan.length;
    connection.console.log(`[onDefinition] Origin span from TS (virtual): start=${originVirtualStart}, length=${originVirtualLength}`);

     // Map virtual origin span back to HTML origin span
     let originHtmlStartOffset: number;
     let originHtmlLength = originVirtualLength; // Start with virtual length

     if (activeMapping.wasThisPrepended && originVirtualStart >= activeMapping.virtualValueRange.start + 6) {
         // Span is likely within the identifier *after* '_this.'
         const relativeVirtualStart = originVirtualStart - (activeMapping.virtualValueRange.start + 6);
         originHtmlStartOffset = activeMapping.htmlExpressionLocation.startOffset + relativeVirtualStart;
     } else if (!activeMapping.wasThisPrepended && originVirtualStart >= activeMapping.virtualValueRange.start) {
        // Span is within the identifier, no '_this.' offset needed
         const relativeVirtualStart = originVirtualStart - activeMapping.virtualValueRange.start;
         originHtmlStartOffset = activeMapping.htmlExpressionLocation.startOffset + relativeVirtualStart;
     } else {
         // Span might be outside the expected value range or involve '_this' itself - map to start of HTML expr for now
         connection.console.warn(`[onDefinition] Origin span calculation fallback for virtual start ${originVirtualStart}`);
         originHtmlStartOffset = activeMapping.htmlExpressionLocation.startOffset;
         originHtmlLength = activeMapping.htmlExpressionLocation.endOffset - activeMapping.htmlExpressionLocation.startOffset; // Highlight whole expression
     }


    // Clamp length to not exceed the original HTML expression boundary
    originHtmlLength = Math.min(originHtmlLength, activeMapping.htmlExpressionLocation.endOffset - originHtmlStartOffset);
    let originHtmlEndOffset = originHtmlStartOffset + originHtmlLength;

     // Ensure valid range
     if (originHtmlStartOffset < activeMapping.htmlExpressionLocation.startOffset || originHtmlEndOffset > activeMapping.htmlExpressionLocation.endOffset) {
         connection.console.warn(`[onDefinition] Calculated origin HTML range [${originHtmlStartOffset}-${originHtmlEndOffset}] exceeds original [${activeMapping.htmlExpressionLocation.startOffset}-${activeMapping.htmlExpressionLocation.endOffset}]. Clamping.`);
          originHtmlStartOffset = Math.max(originHtmlStartOffset, activeMapping.htmlExpressionLocation.startOffset);
         originHtmlEndOffset = Math.min(originHtmlEndOffset, activeMapping.htmlExpressionLocation.endOffset);
     }


    const originSelectionRange = LSPRange.create(
        document.positionAt(originHtmlStartOffset),
        document.positionAt(originHtmlEndOffset)
    );
    connection.console.log(`[onDefinition] Final originSelectionRange (HTML): ${JSON.stringify(originSelectionRange)}`);
    // --- End Origin Span Calculation ---


    for (const def of definitionInfo.definitions) {
        // Skip definitions pointing back to the virtual file itself
        if (def.fileName === docInfo.virtualUri) continue;

        const targetUri = URI.file(def.fileName).toString();
        const targetSourceFile = program?.getSourceFile(def.fileName); // Use program if available

        if (!targetSourceFile) {
             connection.console.warn(`[onDefinition] Could not get source file for definition target: ${def.fileName}`);
             // Create range using line/offset from def if source file not found (less accurate)
             // This requires TS >= 4.7 for line/offset on DefinitionInfo
              // const targetRange = LSPRange.create(def.range.start.line, def.range.start.character, def.range.end.line, def.range.end.character);
             // locationLinks.push(LocationLink.create(targetUri, targetRange, targetRange, originSelectionRange));
             continue; // Skip if we can't get source file and TS version < 4.7
        }

        const targetStartPos = ts.getLineAndCharacterOfPosition(targetSourceFile, def.textSpan.start);
        const targetEndPos = ts.getLineAndCharacterOfPosition(targetSourceFile, def.textSpan.start + def.textSpan.length);

        const targetRange = LSPRange.create(
            targetStartPos.line, targetStartPos.character,
            targetEndPos.line, targetEndPos.character // Correct end character
        );
        // Selection range usually just the start of the definition for navigation
        const targetSelectionRange = LSPRange.create(
            targetStartPos.line, targetStartPos.character,
            targetStartPos.line, targetStartPos.character // Correct selection range (start point)
        );

        locationLinks.push(
            LocationLink.create(targetUri, targetRange, targetSelectionRange, originSelectionRange)
        );
    }

    connection.console.log(`[onDefinition] Returning ${locationLinks.length} mapped LocationLinks.`);
    return locationLinks;
});

// --- Diagnostics ---
function updateDiagnostics(htmlUriString: string): void { // Expect normalized string URI
  if (!serverSettings.diagnostics.enable) {
    // ... clear diagnostics ...
    return;
  }
  const docInfo = aureliaDocuments.get(htmlUriString); // Use string URI as key
  const document = documents.get(htmlUriString);
    if (!docInfo || !document || !languageService) {
    connection.sendDiagnostics({ uri: htmlUriString, diagnostics: [] });
        return;
    }
  const virtualUriToUse = docInfo.virtualUri; // Already normalized string
  const virtualPath = URI.parse(virtualUriToUse).fsPath; // Need fsPath for LS call
  log('debug', `[updateDiagnostics] Getting diagnostics for virtual path: ${virtualPath}`);
    const semanticDiagnostics = languageService.getSemanticDiagnostics(virtualPath);
    const syntacticDiagnostics = languageService.getSyntacticDiagnostics(virtualPath);
    const allVirtualDiagnostics = [...semanticDiagnostics, ...syntacticDiagnostics];

    const htmlDiagnostics: Diagnostic[] = [];

    for (const virtualDiag of allVirtualDiagnostics) {
        if (virtualDiag.start === undefined || virtualDiag.length === undefined) continue;

        const virtualDiagStart = virtualDiag.start;
        const virtualDiagEnd = virtualDiag.start + virtualDiag.length;

        // Find the HTML mapping(s) that this diagnostic overlaps with
        let mapped = false;
        for (const mapping of docInfo.mappings) {
            // Check if the diagnostic range overlaps with the virtual value range
            if (Math.max(virtualDiagStart, mapping.virtualValueRange.start) < Math.min(virtualDiagEnd, mapping.virtualValueRange.end)) {

                // Map the virtual diagnostic range back to the HTML range
                // This is an approximation: map the start of the diag
                const relativeVirtualStart = Math.max(0, virtualDiagStart - mapping.virtualValueRange.start);
                let relativeHtmlStart: number;

                if (mapping.wasThisPrepended) {
                    // Adjust for the virtual '_this.' prefix length (6) if the diagnostic starts after it
                     if (virtualDiagStart >= mapping.virtualValueRange.start + 6) {
                         relativeHtmlStart = (virtualDiagStart - (mapping.virtualValueRange.start + 6));
                     } else {
                         // Diagnostic starts within '_this.' - map to start of HTML expression
                         relativeHtmlStart = 0;
                     }
                } else {
                    relativeHtmlStart = relativeVirtualStart;
                }

                const htmlDiagStartOffset = mapping.htmlExpressionLocation.startOffset + relativeHtmlStart;

                // Estimate the end offset - simple approach: use original length, clamped
                 const virtualLengthInValue = Math.min(virtualDiagEnd, mapping.virtualValueRange.end) - Math.max(virtualDiagStart, mapping.virtualValueRange.start);
                 const htmlDiagEndOffset = Math.min(
                     htmlDiagStartOffset + virtualLengthInValue, // Use mapped length
                     mapping.htmlExpressionLocation.endOffset // Clamp to end of HTML expression
                 );


                // Ensure start <= end and within bounds
                 if (htmlDiagStartOffset < mapping.htmlExpressionLocation.startOffset || htmlDiagStartOffset > mapping.htmlExpressionLocation.endOffset || htmlDiagEndOffset < htmlDiagStartOffset) {
                      connection.console.warn(`[updateDiagnostics] Skipping diagnostic due to invalid mapped range: HTML[${htmlDiagStartOffset}-${htmlDiagEndOffset}] from Virtual[${virtualDiagStart}-${virtualDiagEnd}]`);
                      continue;
                 }

                const htmlRange = LSPRange.create(
                    document.positionAt(htmlDiagStartOffset),
                    document.positionAt(htmlDiagEndOffset)
                );

                htmlDiagnostics.push({
                    severity: mapDiagnosticSeverity(virtualDiag.category),
                    range: htmlRange,
                    message: ts.flattenDiagnosticMessageText(virtualDiag.messageText, '\n'),
                    source: 'Aurelia Linter (via TS)',
                    code: virtualDiag.code,
                });
                mapped = true;
                // break; // Optional: Assign diagnostic to the first matching mapping only? Or allow multiple?
            }
        }
        if (!mapped) {
             // Diagnostic didn't map cleanly to an expression (e.g., issue with import or declaration)
             // Report it at the beginning of the document? Or log it?
              connection.console.log(`[updateDiagnostics] Diagnostic could not be mapped to specific HTML expression: ${ts.flattenDiagnosticMessageText(virtualDiag.messageText, '\n')} (Code: ${virtualDiag.code})`);
              // Optionally add a generic diagnostic at the start of the file
              // htmlDiagnostics.push({ ... });
        }
    }

  connection.sendDiagnostics({ uri: htmlUriString, diagnostics: htmlDiagnostics });
  // connection.console.log(`[updateDiagnostics] Sent ${htmlDiagnostics.length} diagnostics for ${htmlUriString}`); // Verbose
}

function mapDiagnosticSeverity(category: ts.DiagnosticCategory): DiagnosticSeverity {
    switch (category) {
        case ts.DiagnosticCategory.Error: return DiagnosticSeverity.Error;
        case ts.DiagnosticCategory.Warning: return DiagnosticSeverity.Warning;
        case ts.DiagnosticCategory.Message: return DiagnosticSeverity.Information;
        case ts.DiagnosticCategory.Suggestion: return DiagnosticSeverity.Hint;
        default: return DiagnosticSeverity.Information;
    }
}


// Helper to decode TS Semantic Classification
function decodeToken(classification: number): { typeIndex: number; modifierSet: number } | undefined {
  const semanticClassificationFormatShift = 8;
  const classificationTypePropertyName = 9;
    const classificationTypeFunctionName = 10;
    const classificationTypeMethodName = 11;
  const classificationTypeVariableName = 7; // Often identifier or local var

    if (classification > semanticClassificationFormatShift) {
        const type = (classification >> semanticClassificationFormatShift) - 1;
        const modifier = classification & ((1 << semanticClassificationFormatShift) - 1);

        let typeIndex: number | undefined = undefined;
        switch (type) {
      // --- Check numeric literals FIRST for known problematic/overridden enums ---
      case classificationTypeMethodName: // 11
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.method);
        break;
      case classificationTypeFunctionName: // 10
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.function);
        break;
      case classificationTypePropertyName: // 9
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.property);
        break;
      case classificationTypeVariableName: // 7
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.variable);
        break;

      // --- Then check standard enum members ---
      case ts.ClassificationType.className:
        // This case might be hit if className truly is 11, but the numeric case above should catch it first.
        // If it still gets hit, log a warning.
        if (type === 11) {
          // Ensure typeIndex remains set to the method index if it was already set by case 11.
          if (typeIndex === undefined) {
            typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.method);
          }
        } else {
          typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.class);
        }
        break;
      case ts.ClassificationType.enumName:
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.enumMember);
        break;
      case ts.ClassificationType.interfaceName:
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.interface); break;
      case ts.ClassificationType.moduleName:
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.namespace); break;
      case ts.ClassificationType.typeAliasName:
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.type); break;
      case ts.ClassificationType.typeParameterName:
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.typeParameter); break;
      case ts.ClassificationType.parameterName:
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.parameter); break;
      case ts.ClassificationType.keyword:
        typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.keyword); break;

      // Fallback for other identifiers?
      case ts.ClassificationType.identifier:
        if (typeIndex === undefined) typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.variable);
        break;
      default:
        log('debug', `[decodeToken] Type ${type} did not match any case.`);
        break;
    }

        if (typeIndex === undefined || typeIndex === -1) {
      log('debug', `[decodeToken] Unmapped classification type: ${type} (Raw: ${classification})`);
           return undefined;
        }

    // --- Restore Modifier Logic --- 
        let modifierSet = 0;
    const tokenClassDeclarationMask = 256;
    const tokenClassReadonlyMask = 512;

        if (modifier & tokenClassDeclarationMask) {
             const modifierIndex = legend.tokenModifiers.indexOf(SemanticTokenModifiers.declaration);
             if (modifierIndex !== -1) modifierSet |= (1 << modifierIndex);
        }
        if (modifier & tokenClassReadonlyMask) {
             const modifierIndex = legend.tokenModifiers.indexOf(SemanticTokenModifiers.readonly);
             if (modifierIndex !== -1) modifierSet |= (1 << modifierIndex);
        }
    // --- End Modifier Logic ---

    return { typeIndex, modifierSet }; // Correct return

    }
    return undefined;
}

// --- Semantic Tokens ---
connection.languages.semanticTokens.on(async (params: SemanticTokensParams): Promise<SemanticTokens> => {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    const docInfo = aureliaDocuments.get(uri);

    if (!document || !docInfo || !languageService) {
        return { data: [] }; // Return empty tokens if document/info/service not available
    }

  log('debug', `[semanticTokens] Request for ${uri}`);
    const builder = new SemanticTokensBuilder();
  // +++ Ensure fsPath is used +++
  const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;

    try {
        // Use getEncodedSemanticClassifications for efficiency
    log('debug', `[semanticTokens] Getting classifications for: ${virtualFsPath}`);
    const classifications = languageService.getEncodedSemanticClassifications(virtualFsPath, {
            start: 0,
      length: virtualFiles.get(docInfo.virtualUri)?.content.length ?? 0
        }, ts.SemanticClassificationFormat.TwentyTwenty);

        if (!classifications || classifications.spans.length === 0) {
      connection.console.log(`[semanticTokens] No classifications returned from TS for ${virtualFsPath}`);
            return { data: [] };
        }

        connection.console.log(`[semanticTokens] Received ${classifications.spans.length / 3} encoded spans from TS.`);

        for (let i = 0; i < classifications.spans.length; i += 3) {
            const virtualStart = classifications.spans[i];
            const virtualLength = classifications.spans[i + 1];
            const classification = classifications.spans[i + 2];
            const virtualEnd = virtualStart + virtualLength;

      // +++ TEMPORARY DEBUG LOGGING +++
      // Get the text content of the span in the virtual file for context
      const virtualFileContent = virtualFiles.get(docInfo.virtualUri)?.content ?? '';
      const spanText = virtualFileContent.substring(virtualStart, virtualEnd);
      if (spanText === 'toLowerCase') { // Check specifically for toLowerCase
        log('debug', `[semanticTokens] RAW Classification for '${spanText}': number=${classification}`);
      }
      // +++++++++++++++++++++++++++++++

            const decoded = decodeToken(classification);

      // +++ TEMPORARY DEBUG LOGGING +++
      if (spanText === 'toLowerCase') {
        log('debug', `[semanticTokens] DECODED Token for '${spanText}': ${JSON.stringify(decoded)}`);
      }
      // +++++++++++++++++++++++++++++++

            if (!decoded) continue; // Skip if we couldn't map the token type/modifier

            // --- Map Virtual Span back to HTML Range (Refined Logic) --- 
            let mapped = false;
            for (const mapping of docInfo.mappings) {
                // Check if the virtual span is reasonably contained within a mapping's value range
                if (mapping.virtualValueRange.start <= virtualStart && virtualEnd <= mapping.virtualValueRange.end) {
                    let htmlStartOffset: number;
                    let htmlEndOffset: number;
                    const valueVirtualStart = mapping.virtualValueRange.start;
                    const thisPrefixLength = 6;

                     // Calculate HTML start offset
                    if (mapping.wasThisPrepended) {
                        if (virtualStart >= valueVirtualStart + thisPrefixLength) {
                            // Token starts after '_this.', adjust relative offset
                            const relativeVirtualStart = virtualStart - (valueVirtualStart + thisPrefixLength);
                            htmlStartOffset = mapping.htmlExpressionLocation.startOffset + relativeVirtualStart;
      } else {
                            // Token starts within '_this.', skip for now
                             connection.console.warn(`[semanticTokens] Skipping token starting within virtual '_this.' prefix.`);
                            continue;
                        }
                    } else {
                        // No prefix, direct relative mapping
                        const relativeVirtualStart = virtualStart - valueVirtualStart;
                        htmlStartOffset = mapping.htmlExpressionLocation.startOffset + relativeVirtualStart;
                    }

                    // Calculate HTML end offset (using similar logic as start)
                    if (mapping.wasThisPrepended) {
                        if (virtualEnd <= valueVirtualStart + thisPrefixLength) {
                             // Token ends within or before '_this.'
                             htmlEndOffset = mapping.htmlExpressionLocation.startOffset; // Map to start
    } else {
                            // Token ends after '_this.', adjust relative offset
                             const relativeVirtualEnd = virtualEnd - (valueVirtualStart + thisPrefixLength);
                             htmlEndOffset = mapping.htmlExpressionLocation.startOffset + relativeVirtualEnd;
                        }
                    } else {
                        const relativeVirtualEnd = virtualEnd - valueVirtualStart;
                        htmlEndOffset = mapping.htmlExpressionLocation.startOffset + relativeVirtualEnd;
                    }

                     // Clamp to the bounds of the original HTML expression
                     htmlStartOffset = Math.max(htmlStartOffset, mapping.htmlExpressionLocation.startOffset);
                     htmlEndOffset = Math.min(htmlEndOffset, mapping.htmlExpressionLocation.endOffset);
                     // Ensure start <= end after clamping
                     htmlEndOffset = Math.max(htmlStartOffset, htmlEndOffset);

                    if (htmlStartOffset < mapping.htmlExpressionLocation.startOffset || htmlEndOffset > mapping.htmlExpressionLocation.endOffset) {
                         connection.console.warn(`[semanticTokens] Skipping token due to invalid mapped HTML range [${htmlStartOffset}-${htmlEndOffset}] for virtual range [${virtualStart}-${virtualEnd}]`);
                         continue;
                     }

                    // Get line/char positions for the HTML range
                    const startPos = document.positionAt(htmlStartOffset);
                    const endPos = document.positionAt(htmlEndOffset);
                    // Calculate length potentially across lines
                    let line = startPos.line;
                    let startChar = startPos.character;
                    let length = 0;
                    if (line === endPos.line) {
                        length = endPos.character - startPos.character;
                    } else {
                        // Span multiple lines - calculate length more carefully (UTF-16 units)
                        const text = document.getText().substring(htmlStartOffset, htmlEndOffset);
                        length = text.length; // Length in UTF-16 code units
                    }

                    // Push the token using the builder
                    if (length > 0) { // Only push tokens with a positive length
                       builder.push(line, startChar, length, decoded.typeIndex, decoded.modifierSet);
                       mapped = true;
                       break; // Assign token to the first mapping it falls into
                    }
                }
            }
        }

    } catch (e) {
        connection.console.error(`[semanticTokens] Error getting semantic classifications: ${e}`);
        return { data: [] }; // Return empty on error
    }

    connection.console.log(`[semanticTokens] Built tokens for ${uri}`);
    return builder.build();
});

// --- Document Formatting (Placeholder) ---
connection.onDocumentFormatting(async (params: DocumentFormattingParams): Promise<TextEdit[]> => {
  const uri = params.textDocument.uri;
  const document = documents.get(uri);

    if (!document || !uri.endsWith('.html')) {
        connection.console.log('[onDocumentFormatting] Not an HTML document, skipping.');
        return [];
    }

    connection.console.log(`[onDocumentFormatting] Received request for ${uri}`);

    // --- Placeholder Implementation ---
    // Proper formatting requires an Aurelia-aware formatter (e.g., Prettier with plugins).
    // Integrating and running such tools within the language server is complex
    // and often handled by the client (VS Code) calling the formatter directly.
    // This handler provides the capability but performs no formatting for now.

    connection.console.warn('[onDocumentFormatting] Formatting HTML with Aurelia bindings is not implemented in this basic server.');

    // Return empty edits - meaning no changes
    return [];
});

// --- Code Actions ---
connection.onCodeAction(async (params: CodeActionParams): Promise<CodeAction[] | undefined> => {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const codeActions: CodeAction[] = [];
    const startOffset = document.offsetAt(params.range.start);
    const endOffset = document.offsetAt(params.range.end);

    // Find mappings that overlap with the requested range
    const relevantMappings = docInfo.mappings.filter(mapping => {
        // Simple overlap check
        return Math.max(startOffset, mapping.htmlExpressionLocation.startOffset) <=
               Math.min(endOffset, mapping.htmlExpressionLocation.endOffset);
    });

    if (relevantMappings.length === 0) {
        // connection.console.log(`[onCodeAction] No relevant mapping found for range [${startOffset}-${endOffset}]`);
    return undefined;
  }

    // For simplicity, let's primarily work with the first mapping found
    // A more robust solution might aggregate actions or handle multiple mappings
    const primaryMapping = relevantMappings[0];

    // Map the HTML range (or just the start position for now) to the virtual file
    // TODO: Improve mapping of the full range
    const relativeHtmlStartOffset = Math.max(0, startOffset - primaryMapping.htmlExpressionLocation.startOffset);
    let virtualCodeActionOffset: number;
    if (primaryMapping.wasThisPrepended) {
        const baseVirtualOffset = primaryMapping.virtualValueRange.start + 6;
        virtualCodeActionOffset = baseVirtualOffset + relativeHtmlStartOffset;
        virtualCodeActionOffset = Math.max(baseVirtualOffset, Math.min(virtualCodeActionOffset, primaryMapping.virtualValueRange.end));
    } else {
        virtualCodeActionOffset = primaryMapping.virtualValueRange.start + relativeHtmlStartOffset;
        virtualCodeActionOffset = Math.max(primaryMapping.virtualValueRange.start, Math.min(virtualCodeActionOffset, primaryMapping.virtualValueRange.end));
    }

    // Also map the end offset (needed for TS range)
    const relativeHtmlEndOffset = Math.min(endOffset, primaryMapping.htmlExpressionLocation.endOffset) - primaryMapping.htmlExpressionLocation.startOffset;
     let virtualCodeActionEndOffset: number;
     if (primaryMapping.wasThisPrepended) {
         const baseVirtualOffset = primaryMapping.virtualValueRange.start + 6;
         virtualCodeActionEndOffset = baseVirtualOffset + relativeHtmlEndOffset;
         virtualCodeActionEndOffset = Math.max(baseVirtualOffset, Math.min(virtualCodeActionEndOffset, primaryMapping.virtualValueRange.end));
     } else {
         virtualCodeActionEndOffset = primaryMapping.virtualValueRange.start + relativeHtmlEndOffset;
         virtualCodeActionEndOffset = Math.max(primaryMapping.virtualValueRange.start, Math.min(virtualCodeActionEndOffset, primaryMapping.virtualValueRange.end));
     }
     // Ensure start <= end
     virtualCodeActionEndOffset = Math.max(virtualCodeActionOffset, virtualCodeActionEndOffset);


    connection.console.log(`[onCodeAction] HTML Range[${startOffset}-${endOffset}] mapped to Virtual Range[${virtualCodeActionOffset}-${virtualCodeActionEndOffset}] in ${docInfo.virtualUri}`);

    // Get CodeFixes from TypeScript for the virtual file range
    // Note: We might need specific error codes from diagnostics context for more targeted fixes
    const errorCodes: number[] = params.context.diagnostics
        .map(diag => Number(diag.code))
        .filter(code => !isNaN(code));
    // For now, just pass a common error code like 'cannot find name' if specific codes aren't available easily
    // const fixableErrorCodes = errorCodes.length > 0 ? errorCodes : [2304]; // Example: 2304 = Cannot find name '...'.

    try {
    // +++ Ensure fsPath is used +++
    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    log('debug', `[onCodeAction] Getting code fixes for: ${virtualFsPath} [${virtualCodeActionOffset}-${virtualCodeActionEndOffset}]`);
        const codeFixes = languageService.getCodeFixesAtPosition(
      virtualFsPath, // <<< Use fsPath
            virtualCodeActionOffset,
            virtualCodeActionEndOffset,
            errorCodes, // Provide specific error codes from context if possible
            {}, // formatOptions
            {} // preferences
        );

        connection.console.log(`[onCodeAction] TS returned ${codeFixes.length} code fixes.`);

        // --- Map TS CodeFixAction to LSP CodeAction --- 
        for (const fix of codeFixes) {
            // Focus on fixes that change the current file (the virtual file)
            if (fix.changes.length === 1 && fix.changes[0].fileName === docInfo.virtualUri) {
                const virtualChange = fix.changes[0];
                const mappedEdits: TextEdit[] = [];

                for (const textChange of virtualChange.textChanges) {
                    const virtualStart = textChange.span.start;
                    const virtualEnd = textChange.span.start + textChange.span.length;

                    // Find the specific mapping containing this virtual edit span
                    let editMapping = docInfo.mappings.find(m =>
                        m.virtualValueRange.start <= virtualStart && virtualEnd <= m.virtualValueRange.end
                    );
                    // Fallback to primary mapping if no single mapping contains the edit
                    if (!editMapping) {
                         editMapping = primaryMapping;
                    }
                    if (!editMapping) continue; // Skip if still no relevant mapping

                    // --- Further Refined Mapping Logic --- 
                    let htmlStartOffset: number;
                    let htmlEndOffset: number;
                    const valueVirtualStart = editMapping.virtualValueRange.start;
                    const valueVirtualEnd = editMapping.virtualValueRange.end;
                    const htmlExprStart = editMapping.htmlExpressionLocation.startOffset;
                    const htmlExprEnd = editMapping.htmlExpressionLocation.endOffset;
                    const thisPrefixLength = 6; // Length of '_this.'

                    // Check if the entire virtual edit is *before* the actual value (within prefix)
                    if (editMapping.wasThisPrepended && virtualEnd <= valueVirtualStart + thisPrefixLength) {
                        connection.console.warn(`[onCodeAction] Skipping edit entirely within virtual '_this.' prefix.`);
                        continue; // Skip edits that only affect the virtual prefix
                    }

                    // Calculate HTML start offset
                    if (editMapping.wasThisPrepended) {
                        // If virtual start is within or before '_this.', map to start of HTML expr
                        if (virtualStart < valueVirtualStart + thisPrefixLength) {
                            // Edit starts within the prefix but ends after it
                            htmlStartOffset = htmlExprStart; // Map start to beginning of HTML expression
                        } else {
                            // Edit starts after '_this.', adjust relative offset
                            const relativeVirtualStart = virtualStart - (valueVirtualStart + thisPrefixLength);
                            htmlStartOffset = htmlExprStart + relativeVirtualStart;
                        }
                    } else {
                        // No prefix, direct relative mapping
                        const relativeVirtualStart = virtualStart - valueVirtualStart;
                        htmlStartOffset = htmlExprStart + relativeVirtualStart;
                    }

                    // Calculate HTML end offset (similar logic)
                    if (editMapping.wasThisPrepended) {
                        // If virtual end is within or before '_this.', should have been caught above
                        // This assumes edit ends after '_this.'
                        const relativeVirtualEnd = virtualEnd - (valueVirtualStart + thisPrefixLength);
                        htmlEndOffset = htmlExprStart + relativeVirtualEnd;
                    } else {
                        const relativeVirtualEnd = virtualEnd - valueVirtualStart;
                        htmlEndOffset = htmlExprStart + relativeVirtualEnd;
                    }

                    // Clamp strictly to the bounds of the original HTML expression
                    htmlStartOffset = Math.max(htmlStartOffset, htmlExprStart);
                    htmlEndOffset = Math.min(htmlEndOffset, htmlExprEnd);
                    // Ensure start <= end after clamping
                    htmlEndOffset = Math.max(htmlStartOffset, htmlEndOffset);

                    // --- End Further Refined Mapping --- 

                    // Validation
                     if (htmlStartOffset > htmlEndOffset || htmlStartOffset < htmlExprStart || htmlEndOffset > htmlExprEnd) {
                         connection.console.warn(`[onCodeAction] Skipping edit due to final invalid mapped HTML range [${htmlStartOffset}-${htmlEndOffset}] (bounds [${htmlExprStart}-${htmlExprEnd}])`);
                         continue;
                     }

                    const htmlRange = LSPRange.create(
                        document.positionAt(htmlStartOffset),
                        document.positionAt(htmlEndOffset)
                    );

                    // Use the *original* newText from the TS fix
                    mappedEdits.push(TextEdit.replace(htmlRange, textChange.newText));
                }

                if (mappedEdits.length > 0) {
                    const workspaceEdit: WorkspaceEdit = {
                        changes: {
                            [htmlUri]: mappedEdits,
                        }
                    };
                    const codeAction = CodeAction.create(
                        fix.description,
                        workspaceEdit,
                        CodeActionKind.QuickFix // Or map from fix.fixKind?
                    );
                    codeActions.push(codeAction);
                    connection.console.log(`[onCodeAction] Created action: ${fix.description}`);
                }
            }
            // TODO: Handle combined actions or fixes affecting other files?
        }
    } catch (e) {
        connection.console.error(`[onCodeAction] Error getting code fixes: ${e}`);
    }

    return codeActions.length > 0 ? codeActions : undefined;
});

// --- Rename Prepare ---
connection.onPrepareRename(async (params: PrepareRenameParams): Promise<LSPRange | { range: LSPRange, placeholder: string } | null> => {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return null;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return null;

    const offset = document.offsetAt(params.position);

    // Find the active mapping
  let activeMapping: DetailedMapping | undefined;
    for (const mapping of docInfo.mappings) {
        if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
      activeMapping = mapping;
      break;
    }
  }

  if (!activeMapping) {
        // connection.console.log(`[onPrepareRename] Offset ${offset} not within mapped expression.`);
        return null; // Cannot rename outside mapped expressions yet
    }

    // --- Calculate Virtual Offset --- (Similar to other handlers)
    const relativeHtmlOffset = offset - activeMapping.htmlExpressionLocation.startOffset;
  let virtualOffset: number;
    if (activeMapping.wasThisPrepended) {
        const baseVirtualOffset = activeMapping.virtualValueRange.start + 6;
        virtualOffset = baseVirtualOffset + relativeHtmlOffset;
        // Ensure cursor isn't within the 'this.' part for rename
        if (virtualOffset < baseVirtualOffset) {
             connection.console.log(`[onPrepareRename] Cannot rename the virtual '_this.' prefix.`);
             return null;
        }
        virtualOffset = Math.max(baseVirtualOffset, Math.min(virtualOffset, activeMapping.virtualValueRange.end));
  } else {
        virtualOffset = activeMapping.virtualValueRange.start + relativeHtmlOffset;
        virtualOffset = Math.max(activeMapping.virtualValueRange.start, Math.min(virtualOffset, activeMapping.virtualValueRange.end));
    }

    // --- Use TS to check if rename is possible at the virtual location --- 
    // Get definition span first to identify the exact symbol range in virtual file
  // +++ Ensure fsPath is used +++
  const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
  log('debug', `[onPrepareRename] Getting definition for: ${virtualFsPath} at offset ${virtualOffset}`);
  const definitionInfo = languageService.getDefinitionAndBoundSpan(virtualFsPath, virtualOffset);
    if (!definitionInfo || !definitionInfo.definitions || definitionInfo.definitions.length === 0) {
    log('debug', "[onPrepareRename] No definition found at virtual offset, cannot rename.");
        return null;
    }
    const originVirtualSpan = definitionInfo.textSpan; // Span in the virtual file

    // Now check if this specific span can be renamed
  // Note: findRenameLocations itself can return undefined/empty if not possible
  log('debug', `[onPrepareRename] Getting rename info for: ${virtualFsPath} at offset ${originVirtualSpan.start}`);
  const renameInfo = languageService.getRenameInfo(virtualFsPath, originVirtualSpan.start, { allowRenameOfImportPath: false });
  // More robust check than just findRenameLocations
  if (!renameInfo.canRename) {
        // connection.console.log("[onPrepareRename] TS reports rename not possible for the identified span.");
        return null;
    }

    // --- Map Virtual Span back to HTML Range --- (Further Refined)
    const originVirtualStart = originVirtualSpan.start;
    const originVirtualLength = originVirtualSpan.length;
    const originVirtualEnd = originVirtualStart + originVirtualLength;
    let htmlStartOffset: number;
    let htmlEndOffset: number;
    const valueVirtualStart = activeMapping.virtualValueRange.start;
    const valueVirtualEnd = activeMapping.virtualValueRange.end;
    const htmlExprStart = activeMapping.htmlExpressionLocation.startOffset;
    const htmlExprEnd = activeMapping.htmlExpressionLocation.endOffset;
    const thisPrefixLength = 6;

    // Check for overlap with prefix
    if (activeMapping.wasThisPrepended) {
         if (originVirtualEnd <= valueVirtualStart + thisPrefixLength) {
             // Span is entirely within the prefix
             connection.console.warn("[onPrepareRename] Cannot prepare rename for span entirely within virtual '_this.'");
             return null;
         }
         if (originVirtualStart < valueVirtualStart + thisPrefixLength) {
             // Span starts within prefix but ends after it
            htmlStartOffset = htmlExprStart; // Map start to beginning of HTML expression
            const relativeVirtualEnd = originVirtualEnd - (valueVirtualStart + thisPrefixLength);
            htmlEndOffset = htmlExprStart + relativeVirtualEnd;
         } else {
            // Span starts after '_this.'
            const relativeVirtualStart = originVirtualStart - (valueVirtualStart + thisPrefixLength);
            htmlStartOffset = htmlExprStart + relativeVirtualStart;
            const relativeVirtualEnd = originVirtualEnd - (valueVirtualStart + thisPrefixLength);
            htmlEndOffset = htmlExprStart + relativeVirtualEnd;
         }
    } else {
        // No prefix, direct relative mapping
        const relativeVirtualStart = originVirtualStart - valueVirtualStart;
        htmlStartOffset = htmlExprStart + relativeVirtualStart;
        const relativeVirtualEnd = originVirtualEnd - valueVirtualStart;
        htmlEndOffset = htmlExprStart + relativeVirtualEnd;
    }

    // Clamp strictly to the bounds of the original HTML expression
    htmlStartOffset = Math.max(htmlStartOffset, htmlExprStart);
    htmlEndOffset = Math.min(htmlEndOffset, htmlExprEnd);
    // Ensure start <= end after clamping
    htmlEndOffset = Math.max(htmlStartOffset, htmlEndOffset);

    if (htmlStartOffset >= htmlEndOffset || htmlStartOffset < htmlExprStart || htmlEndOffset > htmlExprEnd) {
        connection.console.warn(`[onPrepareRename] Invalid mapped HTML range after clamping [${htmlStartOffset}-${htmlEndOffset}]`);
        return null;
    }

    const htmlRange = LSPRange.create(
        document.positionAt(htmlStartOffset),
        document.positionAt(htmlEndOffset)
    );
    const placeholder = document.getText(htmlRange);

    connection.console.log(`[onPrepareRename] Rename possible for range: ${JSON.stringify(htmlRange)}, placeholder: ${placeholder}`);
    // Return range and placeholder
    return { range: htmlRange, placeholder };
});

// --- Rename Request ---
connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | undefined> => {
    // +++ Add entry log +++
    connection.console.log(`[onRenameRequest] Handler Entered. URI: ${params.textDocument.uri}`);
    // +++++++++++++++++++++
    
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const offset = document.offsetAt(params.position);
    const newName = params.newName;

    // Find the active mapping
    let activeMapping: DetailedMapping | undefined;
    for (const mapping of docInfo.mappings) {
        if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
            activeMapping = mapping;
            break;
        }
    }

    if (!activeMapping) {
        connection.console.log(`[onRenameRequest] Offset ${offset} not within mapped expression.`);
        return undefined; 
    }

    // --- Calculate Virtual Offset --- 
    const relativeHtmlOffset = offset - activeMapping.htmlExpressionLocation.startOffset;
    let virtualOffset: number;
  if (activeMapping.wasThisPrepended) {
        const baseVirtualOffset = activeMapping.virtualValueRange.start + 6;
        virtualOffset = baseVirtualOffset + relativeHtmlOffset;
        if (virtualOffset < baseVirtualOffset) {
             connection.console.warn(`[onRenameRequest] Cannot initiate rename from within virtual '_this.' prefix.`);
             return undefined; // Don't allow rename starting on 'this.'
        }
        virtualOffset = Math.max(baseVirtualOffset, Math.min(virtualOffset, activeMapping.virtualValueRange.end));
  } else {
        virtualOffset = activeMapping.virtualValueRange.start + relativeHtmlOffset;
        virtualOffset = Math.max(activeMapping.virtualValueRange.start, Math.min(virtualOffset, activeMapping.virtualValueRange.end));
    }

    // --- Find Rename Locations using TS --- 
    // Use the virtual offset to ensure we are renaming the correct symbol
  // +++ Ensure fsPath is used +++
  const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
  log('debug', `[onRenameRequest] Finding rename locations for: ${virtualFsPath} at offset ${virtualOffset}`);
    const renameLocations = languageService.findRenameLocations(
    virtualFsPath, // <<< Use fsPath
        virtualOffset, 
        false, // findInStrings
        false // findInComments
        // Consider adding preferences: providePrefixAndSuffixTextForRename
    );

    if (!renameLocations) {
        connection.console.log("[onRenameRequest] TS could not find rename locations.");
        return undefined;
    }

    connection.console.log(`[onRenameRequest] Found ${renameLocations.length} potential rename locations.`);

    // --- Collect changes into a map first ---
    const editsByUri: Map<string, TextEdit[]> = new Map();
    for (const location of renameLocations) {
        log('debug', `  - Processing Location: File='${location.fileName}', Start=${location.textSpan.start}, Length=${location.textSpan.length}`);
        
        // +++ Normalize targetFsPath +++
        const targetFsPathRaw = location.fileName; 
        const targetFsPath = targetFsPathRaw.replace(/\\/g, '/'); 
        // ++++++++++++++++++++++++++++++++

        let targetUri = URI.file(targetFsPathRaw).toString(); // Use original raw path for URI creation
        const locationVirtualSpan = location.textSpan;
        const virtualStart = locationVirtualSpan.start;
        const virtualLength = locationVirtualSpan.length;
        const virtualEnd = virtualStart + virtualLength;
        let targetRange: LSPRange | undefined;

        // Case 1: Location is in the original ViewModel file
        // +++ Normalize comparison paths +++
        const normalizedVmFsPath = docInfo.vmFsPath.replace(/\\/g, '/');
        const normalizedVirtualFsPath = URI.parse(docInfo.virtualUri).fsPath.replace(/\\/g, '/');
        if (targetFsPath === normalizedVmFsPath) { 
        // +++++++++++++++++++++++++++++++++
            log('debug', `    - Location is in VM file: ${targetFsPath}`);
            const program = languageService.getProgram();
            const vmSourceFile = program?.getSourceFile(targetFsPathRaw); // Use raw path for TS API
            if (vmSourceFile) {
                const vmDocument = TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPathRaw) ?? ''); // Create temporary doc for offset mapping
                if (vmDocument) {
                    targetRange = LSPRange.create(
                        vmDocument.positionAt(virtualStart),
                        vmDocument.positionAt(virtualEnd)
                    );
                }
            }
        }
        // Case 2: Location is in the Virtual File (needs mapping back to HTML)
        // +++ Normalize comparison paths +++
        else if (targetFsPath === normalizedVirtualFsPath) { 
        // +++++++++++++++++++++++++++++++++
             log('debug', `    - Location is in Virtual file: ${targetFsPath}`);
             let locationMapping = docInfo.mappings.find(m => 
                 Math.max(virtualStart, m.virtualValueRange.start) < Math.min(virtualEnd, m.virtualValueRange.end)
             );
             if (!locationMapping) {
                 // Attempt fallback if span overlaps but isn't fully contained?
                 // For now, skip if no containing mapping found
                 connection.console.warn(`[onRenameRequest] Could not find mapping for virtual rename location [${virtualStart}-${virtualEnd}]`);
                 continue;
             }

            // --- Refined Map Virtual Span to HTML Range --- 
            let htmlStartOffset: number;
            let htmlEndOffset: number;
            const valueVirtualStart = locationMapping.virtualValueRange.start;
            const valueVirtualEnd = locationMapping.virtualValueRange.end;
            const htmlExprStart = locationMapping.htmlExpressionLocation.startOffset;
            const htmlExprEnd = locationMapping.htmlExpressionLocation.endOffset;
            const thisPrefixLength = 6;

            // Check for overlap with prefix
             if (locationMapping.wasThisPrepended) {
                 if (virtualEnd <= valueVirtualStart + thisPrefixLength) {
                     // Span is entirely within the prefix, skip
                     connection.console.warn("[onRenameRequest] Skipping rename location entirely within virtual '_this.'");
      continue;
                 }
                 if (virtualStart < valueVirtualStart + thisPrefixLength) {
                     // Span starts within prefix but ends after it
                    htmlStartOffset = htmlExprStart;
                    const relativeVirtualEnd = virtualEnd - (valueVirtualStart + thisPrefixLength);
                    htmlEndOffset = htmlExprStart + relativeVirtualEnd;
                 } else {
                    // Span starts after '_this.'
                    const relativeVirtualStart = virtualStart - (valueVirtualStart + thisPrefixLength);
                    htmlStartOffset = htmlExprStart + relativeVirtualStart;
                    const relativeVirtualEnd = virtualEnd - (valueVirtualStart + thisPrefixLength);
                    htmlEndOffset = htmlExprStart + relativeVirtualEnd;
                 }
             } else {
                 // No prefix, direct relative mapping
                 const relativeVirtualStart = virtualStart - valueVirtualStart;
                 htmlStartOffset = htmlExprStart + relativeVirtualStart;
                 const relativeVirtualEnd = virtualEnd - valueVirtualStart;
                 htmlEndOffset = htmlExprStart + relativeVirtualEnd;
             }

            // Clamp strictly to the bounds of the original HTML expression
             htmlStartOffset = Math.max(htmlStartOffset, htmlExprStart);
             htmlEndOffset = Math.min(htmlEndOffset, htmlExprEnd);
            // Ensure start <= end after clamping
             htmlEndOffset = Math.max(htmlStartOffset, htmlEndOffset);

             if (htmlStartOffset >= htmlEndOffset || htmlStartOffset < htmlExprStart || htmlEndOffset > htmlExprEnd) {
                connection.console.warn(`[onRenameRequest] Invalid mapped HTML range after clamping [${htmlStartOffset}-${htmlEndOffset}] for virtual rename location [${virtualStart}-${virtualEnd}]`);
        continue;
    }

            targetRange = LSPRange.create(
                document.positionAt(htmlStartOffset),
                document.positionAt(htmlEndOffset)
            );
            // +++ Log final target range +++
            log('debug', `    - Final Mapped HTML Range: ${JSON.stringify(targetRange)} for Virtual [${virtualStart}-${virtualEnd}]`);
            // ++++++++++++++++++++++++++++++
            
            // +++ Force targetUri to the original HTML URI for virtual file edits +++
            targetUri = htmlUri; 
            log('debug', `    - Overriding target URI to HTML URI: ${targetUri}`);
            // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
        }
        // Case 3: Location is in some other file (e.g., imported utility type) - handle as is
        else {
             log('debug', `    - Location is in other file: ${targetFsPath}`);
             const program = languageService.getProgram();
             const otherSourceFile = program?.getSourceFile(targetFsPathRaw); // Use raw path for TS API
             if (otherSourceFile) {
                 // Use ts.getLineAndCharacterOfPosition instead of positionAt
                 const startPos = ts.getLineAndCharacterOfPosition(otherSourceFile, virtualStart);
                 const endPos = ts.getLineAndCharacterOfPosition(otherSourceFile, virtualEnd);
                 targetRange = LSPRange.create(
                     startPos.line, startPos.character,
                     endPos.line, endPos.character
                 );
             }
        }

        // Add the edit if we successfully determined the range
        if (targetRange) {
             if (!editsByUri.has(targetUri)) {
                 editsByUri.set(targetUri, []);
             }
             editsByUri.get(targetUri)?.push(TextEdit.replace(targetRange, newName));
        }
    }

    if (editsByUri.size === 0) {
        connection.console.log("[onRenameRequest] No mappable locations found after processing TS results.");
        return undefined;
    }

    // --- Create documentChanges array ---
    const documentChanges: TextDocumentEdit[] = [];
    for (const [uri, edits] of editsByUri.entries()) {
        // Need the version of the document for TextDocumentEdit
        // For the HTML file, use the version from the initial 'document' object
        // For other TS files, we might need to get the TextDocument object if open,
        // or potentially omit the version (or use 0?) if not open.
        // Let's start by handling the HTML file correctly.
        let version: number | null = null; // Use null for unknown version
        const doc = documents.get(uri);
        if (doc) {
            version = doc.version;
        }
        // If version is null, the client might ignore the version check.
        documentChanges.push(TextDocumentEdit.create({ uri, version }, edits));
    }

    // Return the WorkspaceEdit with documentChanges
    return { documentChanges };
});

// --- Find References ---
connection.onReferences(async (params: ReferenceParams): Promise<LSPLocation[] | undefined> => {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const offset = document.offsetAt(params.position);

    // Find the active mapping
    let activeMapping: DetailedMapping | undefined;
    for (const mapping of docInfo.mappings) {
        if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
            activeMapping = mapping;
            break;
        }
    }

    if (!activeMapping) {
        connection.console.log(`[onReferences] Offset ${offset} not within mapped expression.`);
        return undefined; 
    }

    // --- Calculate Virtual Offset --- 
    const relativeHtmlOffset = offset - activeMapping.htmlExpressionLocation.startOffset;
    let virtualOffset: number;
    if (activeMapping.wasThisPrepended) {
        const baseVirtualOffset = activeMapping.virtualValueRange.start + 6;
        virtualOffset = baseVirtualOffset + relativeHtmlOffset;
        if (virtualOffset < baseVirtualOffset) {
             connection.console.warn(`[onReferences] Cannot find references for virtual '_this.' prefix.`);
             return undefined;
        }
        virtualOffset = Math.max(baseVirtualOffset, Math.min(virtualOffset, activeMapping.virtualValueRange.end));
    } else {
        virtualOffset = activeMapping.virtualValueRange.start + relativeHtmlOffset;
        virtualOffset = Math.max(activeMapping.virtualValueRange.start, Math.min(virtualOffset, activeMapping.virtualValueRange.end));
    }

    // --- Find References using TS --- 
  // +++ Ensure fsPath is used +++
  const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
  log('debug', `[onReferences] Finding references for: ${virtualFsPath} at offset ${virtualOffset}`);
    const referencedSymbols = languageService.findReferences(
    virtualFsPath, // <<< Use fsPath
        virtualOffset 
    );

    if (!referencedSymbols) {
        connection.console.log("[onReferences] TS could not find reference symbols.");
        return undefined;
    }

    const locations: LSPLocation[] = [];
    connection.console.log(`[onReferences] Found ${referencedSymbols.length} referenced symbols.`);

    // --- Iterate through each symbol and its references --- 
    for (const symbol of referencedSymbols) {
        connection.console.log(`  - Symbol has ${symbol.references.length} references.`);
        for (const reference of symbol.references) {
             const targetFsPath = reference.fileName;
             const targetUri = URI.file(targetFsPath).toString();
             const locationVirtualSpan = reference.textSpan;
             const virtualStart = locationVirtualSpan.start;
             const virtualLength = locationVirtualSpan.length;
             const virtualEnd = virtualStart + virtualLength;

             let targetRange: LSPRange | undefined;

             // Case 1: Location is in the original ViewModel file
             if (targetFsPath === docInfo.vmFsPath) {
                 const vmDocument = TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPath) ?? '');
                 if (vmDocument) {
                      targetRange = LSPRange.create(
                          vmDocument.positionAt(virtualStart),
                          vmDocument.positionAt(virtualEnd)
                      );
                 }
             }
             // Case 2: Location is in the Virtual File (needs mapping back to HTML)
             else if (targetFsPath === URI.parse(docInfo.virtualUri).fsPath) {
                  let locationMapping = docInfo.mappings.find(m => 
                      m.virtualValueRange.start <= virtualStart && virtualEnd <= m.virtualValueRange.end
                  );
                  if (!locationMapping) {
                      connection.console.warn(`[onReferences] Could not find mapping for virtual reference location [${virtualStart}-${virtualEnd}]`);
                      continue;
                  }

                 // Map Virtual Span to HTML Range (using refined logic)
                 let htmlStartOffset: number;
                 let htmlEndOffset: number;
                 const valueVirtualStart = locationMapping.virtualValueRange.start;
                 const thisPrefixLength = 6;

                 if (locationMapping.wasThisPrepended) {
                     if (virtualStart >= valueVirtualStart + thisPrefixLength) {
                         const relativeVirtualStart = virtualStart - (valueVirtualStart + thisPrefixLength);
                         htmlStartOffset = locationMapping.htmlExpressionLocation.startOffset + relativeVirtualStart;
                         const relativeVirtualEnd = virtualEnd - (valueVirtualStart + thisPrefixLength);
                         htmlEndOffset = locationMapping.htmlExpressionLocation.startOffset + relativeVirtualEnd;
                     } else {
                          connection.console.warn("[onReferences] Cannot map reference location starting within virtual '_this.'");
                         continue;
                     }
                 } else {
                     const relativeVirtualStart = virtualStart - valueVirtualStart;
                     htmlStartOffset = locationMapping.htmlExpressionLocation.startOffset + relativeVirtualStart;
                     const relativeVirtualEnd = virtualEnd - valueVirtualStart;
                     htmlEndOffset = locationMapping.htmlExpressionLocation.startOffset + relativeVirtualEnd;
                 }

                 htmlStartOffset = Math.max(htmlStartOffset, locationMapping.htmlExpressionLocation.startOffset);
                 htmlEndOffset = Math.min(htmlEndOffset, locationMapping.htmlExpressionLocation.endOffset);
                 htmlEndOffset = Math.max(htmlStartOffset, htmlEndOffset);

                  if (htmlStartOffset < locationMapping.htmlExpressionLocation.startOffset || htmlEndOffset > locationMapping.htmlExpressionLocation.endOffset) {
                     connection.console.warn(`[onReferences] Invalid mapped HTML range [${htmlStartOffset}-${htmlEndOffset}] for virtual reference location [${virtualStart}-${virtualEnd}]`);
                     continue;
                 }

                 targetRange = LSPRange.create(
                     document.positionAt(htmlStartOffset),
                     document.positionAt(htmlEndOffset)
                 );
             }
             // Case 3: Location is in some other TS file
             else {
                  const otherDocument = TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPath) ?? '');
                   if (otherDocument) {
                      targetRange = LSPRange.create(
                          otherDocument.positionAt(virtualStart),
                          otherDocument.positionAt(virtualEnd)
                      );
                   }
             }

             // Add the mapped location if range was determined
             if (targetRange) {
                  locations.push(LSPLocation.create(targetUri, targetRange));
             }
        }
    }

    connection.console.log(`[onReferences] Returning ${locations.length} mapped locations.`);
    return locations;
});

// --- Hover --- 
connection.onHover(async (params: HoverParams): Promise<Hover | undefined> => {
  const htmlUri = params.textDocument.uri;
  const document = documents.get(htmlUri);
  if (!document || !htmlUri.endsWith('.html')) return undefined;

  const docInfo = aureliaDocuments.get(htmlUri);
  if (!docInfo) return undefined;

  const offset = document.offsetAt(params.position);

  // --- Find Active Mapping --- 
  let activeMapping: DetailedMapping | undefined;
  for (const mapping of docInfo.mappings) {
    // Hover needs precise location *within* the expression bounds
    if (mapping.htmlExpressionLocation.startOffset <= offset && offset < mapping.htmlExpressionLocation.endOffset) {
      activeMapping = mapping;
      break;
    }
    // Allow hover on the very last character too
    if (offset === mapping.htmlExpressionLocation.endOffset && mapping.htmlExpressionLocation.startOffset !== mapping.htmlExpressionLocation.endOffset) {
      activeMapping = mapping;
      break;
    }
  }

  // --- Branch 1: Hover INSIDE an Aurelia expression --- 
  if (activeMapping) {
    log('debug', `[onHover] Offset ${offset} is inside mapped expression.`);
    // Calculate position within the *original* HTML expression
    const relativeHtmlOffset = offset - activeMapping.htmlExpressionLocation.startOffset;

    // Calculate the corresponding offset in the *virtual* file's expression value
    let virtualHoverOffset: number;
    if (activeMapping.wasThisPrepended) {
      const baseVirtualOffset = activeMapping.virtualValueRange.start + 6; // After '_this.'
      virtualHoverOffset = baseVirtualOffset + relativeHtmlOffset;
      // Don't allow hover within the virtual '_this.' itself
      if (virtualHoverOffset < baseVirtualOffset) {
        log('debug', '[onHover] Hover offset maps to virtual prefix, skipping TS lookup.');
        return undefined;
      }
      virtualHoverOffset = Math.max(baseVirtualOffset, Math.min(virtualHoverOffset, activeMapping.virtualValueRange.end));
    } else {
      virtualHoverOffset = activeMapping.virtualValueRange.start + relativeHtmlOffset;
      virtualHoverOffset = Math.max(activeMapping.virtualValueRange.start, Math.min(virtualHoverOffset, activeMapping.virtualValueRange.end));
    }

    log('debug', `[onHover] Mapped HTML Offset: ${offset} to Virtual Offset: ${virtualHoverOffset} in ${docInfo.virtualUri}`);

    // Get QuickInfo (hover info) from TS Language Service
    // +++ Ensure fsPath is used +++
    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    log('debug', `[onHover] Getting QuickInfo for: ${virtualFsPath} at offset ${virtualHoverOffset}`);
    const quickInfo = languageService.getQuickInfoAtPosition(virtualFsPath, virtualHoverOffset);

    if (!quickInfo || !quickInfo.displayParts) {
      log('debug', '[onHover] TS returned no QuickInfo.');
      return undefined;
    }

    // --- Map Virtual Span back to HTML Range --- (Use Refined Mapping)
    const originVirtualSpan = quickInfo.textSpan;
    const originVirtualStart = originVirtualSpan.start;
    const originVirtualLength = originVirtualSpan.length;
    const originVirtualEnd = originVirtualStart + originVirtualLength;

    const mapOffset = (virtualOffset: number, mapping: DetailedMapping): number | null => {
      const valueVirtualStart = mapping.virtualValueRange.start;
      const valueVirtualEnd = mapping.virtualValueRange.end;
      const htmlExprStart = mapping.htmlExpressionLocation.startOffset;
      const thisPrefixLength = 6;
      const clampedVirtualOffset = Math.max(valueVirtualStart, Math.min(virtualOffset, valueVirtualEnd));
      if (mapping.wasThisPrepended) {
        if (clampedVirtualOffset < valueVirtualStart + thisPrefixLength) return null;
        else return htmlExprStart + (clampedVirtualOffset - (valueVirtualStart + thisPrefixLength));
      } else {
        return htmlExprStart + (clampedVirtualOffset - valueVirtualStart);
      }
    };

    const htmlStartOffsetNullable = mapOffset(originVirtualStart, activeMapping);
    const htmlEndOffsetNullable = mapOffset(originVirtualEnd, activeMapping);

    let htmlRange: LSPRange | undefined;

    if (htmlStartOffsetNullable !== null && htmlEndOffsetNullable !== null) {
      let htmlStartOffset = htmlStartOffsetNullable;
      let htmlEndOffset = htmlEndOffsetNullable;
      // Clamp & Validate
      htmlStartOffset = Math.max(htmlStartOffset, activeMapping.htmlExpressionLocation.startOffset);
      htmlEndOffset = Math.min(htmlEndOffset, activeMapping.htmlExpressionLocation.endOffset);
      htmlEndOffset = Math.max(htmlStartOffset, htmlEndOffset);

      if (htmlStartOffset < htmlEndOffset) { // Only create range if valid
        htmlRange = LSPRange.create(
          document.positionAt(htmlStartOffset),
          document.positionAt(htmlEndOffset)
        );
      }
    } else {
      log('debug', `[onHover] Could not map virtual span [${originVirtualStart}-${originVirtualEnd}] back to HTML, hover range omitted.`);
      // Fallback: Maybe use the whole expression range? For now, omit range.
      // htmlRange = LSPRange.create(
      //     document.positionAt(activeMapping.htmlExpressionLocation.startOffset),
      //     document.positionAt(activeMapping.htmlExpressionLocation.endOffset)
      // );
    }
    // ----------------------------------------

    // Format QuickInfo into LSP Hover
    const contents: MarkedString[] = [];
    // Type information (formatted as TypeScript code block)
    const typeString = ts.displayPartsToString(quickInfo.displayParts);
    contents.push({ language: 'typescript', value: typeString });

    // Documentation (if available)
    if (quickInfo.documentation && quickInfo.documentation.length > 0) {
      contents.push(ts.displayPartsToString(quickInfo.documentation));
    }

    // Tags (like @deprecated, @param - add if needed)
    // if (quickInfo.tags) { ... }

    log('debug', `[onHover] Providing hover info for range: ${JSON.stringify(htmlRange)}`);
    return { contents, range: htmlRange };

  }

  // --- Branch 2: Hover OUTSIDE an Aurelia expression --- 
  else {
    log('debug', `[onHover] Offset ${offset} is outside mapped expressions.`);
    // TODO: Implement hover for HTML tags/attributes (Aurelia components/standard)
    // - Use parse5 or regex to identify tag/attribute under cursor
    // - Check against aureliaProjectComponents map
    // - Check against STANDARD_HTML_TAGS / ELEMENT_SPECIFIC_ATTRIBUTES
    // - Provide basic info
    return undefined; // Placeholder
  }
});

// --- Signature Help --- 
// ... existing signature help handler ...

// --- Server Listen ---
connection.listen();
documents.listen(connection); // Start listening for document changes on connected document manager
connection.onShutdown(() => {
    // Dispose language service?
});

// +++ NEW Helper: Get Bindable Properties from Class Node +++
function getBindablePropertiesFromClassNode(classNode: ts.ClassDeclaration, sourceFile: ts.SourceFile): string[] {
  const bindables: string[] = [];
  if (!classNode.members) return bindables;

  log('debug', `    - Checking for bindables in class: ${classNode.name?.getText(sourceFile)}`);
  classNode.members.forEach(member => {
    if (ts.isPropertyDeclaration(member) && member.name) {
      const decorators = ts.getDecorators(member);
      if (decorators && decorators.length > 0) {
        for (const decorator of decorators) {
          let decoratorName: string | undefined;
          const decoratorExpr = decorator.expression;
          if (ts.isCallExpression(decoratorExpr) && ts.isIdentifier(decoratorExpr.expression)) {
            decoratorName = decoratorExpr.expression.getText(sourceFile);
          } else if (ts.isIdentifier(decoratorExpr)) {
            decoratorName = decoratorExpr.getText(sourceFile);
          }
          if (decoratorName === 'bindable') {
            const propertyName = member.name.getText(sourceFile);
            log('debug', `      - Found @bindable property: ${propertyName}`);
            bindables.push(propertyName);
            break;
          }
        }
      }
    }
  });
  return bindables;
}
// +++++++++++++++++++++++++++++++++++++++++++++++++++++++
