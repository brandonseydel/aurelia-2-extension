"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const ts = __importStar(require("typescript"));
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const path = __importStar(require("path"));
const vscode_uri_1 = require("vscode-uri");
const parse5 = __importStar(require("parse5"));
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
let languageService;
let virtualFiles = new Map();
let mappings = new Map();
let strictMode = false;
let workspaceRoot = process.cwd(); // Store workspace root
// --- Helper Functions ---
function kebabToPascalCase(str) {
    return str.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}
// Helper to check if an expression looks like a simple identifier needing \'this.\'
function needsThisPrefix(expression) {
    const trimmed = expression.trim();
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(trimmed) &&
        trimmed !== 'this' &&
        trimmed !== 'true' &&
        trimmed !== 'false' &&
        trimmed !== 'null' &&
        trimmed !== 'undefined' &&
        !/^\d/.test(trimmed) &&
        !/^[\'\"`]/.test(trimmed);
}
function extractExpressions(htmlContent) {
    // connection.console.log(`[extractExpressions] Received HTML content:\n---\n${htmlContent}\n---`); // Keep commented for now
    const document = parse5.parse(htmlContent, { sourceCodeLocationInfo: true });
    const expressions = [];
    const interpolationRegex = /\$\{([^}]*)\}/g; // Allow empty
    const traverse = (node) => {
        // connection.console.log(`[traverse] Visiting node: ${node.nodeName}`); // Keep commented
        // 1. Check Text Nodes
        if (node.nodeName === '#text' && node.sourceCodeLocation) {
            const textNode = node;
            const textContent = textNode.value;
            const nodeStartOffset = textNode.sourceCodeLocation.startOffset;
            // connection.console.log(`[traverse] TextNode value: "${textContent}", offset: ${nodeStartOffset}`); // Keep commented
            let match;
            interpolationRegex.lastIndex = 0; // Reset before searching this text node
            while ((match = interpolationRegex.exec(textContent)) !== null) {
                const expression = match[1];
                const start = nodeStartOffset + match.index + 2;
                const end = start + expression.length;
                // connection.console.log(`[traverse] Found text expression: ${expression} at [${start}, ${end}]`); // Keep commented
                expressions.push({ expression, start, end });
            }
        }
        // 2. Check Element Attributes
        if ('attrs' in node && node.attrs && node.sourceCodeLocation) {
            const element = node;
            // connection.console.log(`[traverse] Checking attributes for element: ${element.nodeName}`); // Keep commented
            for (const attr of element.attrs) {
                if (element.sourceCodeLocation?.attrs?.[attr.name]) {
                    const attrLocation = element.sourceCodeLocation.attrs[attr.name];
                    const attrValue = attr.value;
                    const attrValueStartOffset = attrLocation.startOffset + attr.name.length + 2; // Account for =\" or =\'
                    // connection.console.log(`[traverse] Attr: ${attr.name}="${attrValue}", valueOffset: ${attrValueStartOffset}`); // Keep commented
                    let match;
                    interpolationRegex.lastIndex = 0; // Reset before searching this attribute value
                    while ((match = interpolationRegex.exec(attrValue)) !== null) {
                        const expression = match[1];
                        const start = attrValueStartOffset + match.index + 2; // +2 for '${'
                        const end = start + expression.length;
                        // connection.console.log(`[traverse] Found attribute expression: ${expression} at [${start}, ${end}]`); // Keep commented
                        expressions.push({ expression, start, end });
                    }
                }
            }
        }
        // 3. Traverse Children
        const elementNode = node;
        if (elementNode.childNodes) {
            elementNode.childNodes.forEach(traverse);
        }
        // 4. Handle <template> content
        if (node.nodeName === 'template' && 'content' in node && node.content) {
            traverse(node.content);
        }
    };
    traverse(document);
    // connection.console.log(`[extractExpressions] Found expressions: ${JSON.stringify(expressions)}`); // Keep commented
    return expressions;
}
// Helper function to escape regex special characters
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}
// Helper function to get member names 
function getViewModelMemberNames(vmClassName, vmFsPath) {
    let memberNames = [];
    try {
        // Ensure languageService is available
        if (!languageService) {
            connection.console.error(`[getViewModelMemberNames] Language service not initialized.`);
            return ['heading', 'features', 'user', 'message', 'title', 'description']; // Return fallback immediately
        }
        const program = languageService.getProgram();
        if (program) {
            const typeChecker = program.getTypeChecker();
            const sourceFile = program.getSourceFile(vmFsPath);
            if (sourceFile) {
                connection.console.log(`[getViewModelMemberNames] Found source file for VM: ${vmFsPath}`);
                let classDeclaration;
                ts.forEachChild(sourceFile, node => {
                    if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === vmClassName) {
                        const hasExport = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false;
                        const hasDefault = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
                        if (hasExport || hasDefault) {
                            connection.console.log(`[getViewModelMemberNames] Found exported class declaration for: ${vmClassName}`);
                            classDeclaration = node;
                        }
                    }
                });
                if (classDeclaration?.name) {
                    const classSymbol = typeChecker.getSymbolAtLocation(classDeclaration.name);
                    if (classSymbol) {
                        const classType = typeChecker.getDeclaredTypeOfSymbol(classSymbol);
                        const properties = typeChecker.getPropertiesOfType(classType);
                        connection.console.log(`[getViewModelMemberNames] Found ${properties.length} potential members for ${vmClassName}.`);
                        properties.forEach(prop => {
                            const propName = prop.getName();
                            if (propName && propName !== 'constructor' && !propName.startsWith('_')) {
                                memberNames.push(propName);
                            }
                        });
                    }
                    else {
                        connection.console.warn(`[getViewModelMemberNames] Could not get symbol for class ${vmClassName}.`);
                    }
                }
                else {
                    connection.console.warn(`[getViewModelMemberNames] Could not find exported class declaration node for ${vmClassName}.`);
                }
            }
            else {
                connection.console.warn(`[getViewModelMemberNames] Could not get source file object for ${vmFsPath}.`);
            }
        }
        else {
            connection.console.warn('[getViewModelMemberNames] Could not get program from language service.');
        }
    }
    catch (e) {
        connection.console.error(`[getViewModelMemberNames] Error retrieving members for ${vmClassName}: ${e}`);
    }
    connection.console.log(`[getViewModelMemberNames] Final members for ${vmClassName}: [${memberNames.join(', ')}]`);
    if (memberNames.length === 0) {
        connection.console.warn(`[getViewModelMemberNames] No members found dynamically for ${vmClassName}, using fallback.`);
        memberNames = ['heading', 'features', 'user', 'message', 'title', 'description'];
    }
    return memberNames;
}
function updateVirtualFile(htmlUri, htmlContent) {
    const htmlFsPath = vscode_uri_1.URI.parse(htmlUri).fsPath;
    const vmFsPath = htmlFsPath.replace(/\.html$/, ".ts");
    const baseName = path.basename(vmFsPath, ".ts");
    const vmClassName = kebabToPascalCase(baseName);
    const virtualFileUri = htmlUri + ".virtual.ts";
    const virtualFsPath = vscode_uri_1.URI.parse(virtualFileUri).fsPath;
    let relativeImportPath = path.relative(path.dirname(virtualFsPath), vmFsPath)
        .replace(/\\/g, "/")
        .replace(/\.ts$/, "");
    if (!relativeImportPath.startsWith(".")) {
        relativeImportPath = "./" + relativeImportPath;
    }
    const expressions = extractExpressions(htmlContent);
    const memberNames = getViewModelMemberNames(vmClassName, vmFsPath); // Get member names first
    // --- Build Base --- 
    let virtualContent = `// Import the actual ViewModel\n`;
    virtualContent += `import { ${vmClassName} } from \'${relativeImportPath}\';\n\n`;
    virtualContent += `// Declare 'this' context\n`;
    virtualContent += `declare const _this: ${vmClassName};\n\n`;
    virtualContent += `// --- Expression Placeholders ---\n`;
    const detailedMappings = [];
    let currentOffset = virtualContent.length; // Track current position
    let exprIndex = 1;
    for (const expr of expressions) {
        const placeholderVarName = `___expr_${exprIndex}`;
        let wasThisPrepended = false; // Initialize flag
        let transformedExpression;
        // --- Transformation Logic (using _this) --- 
        let originalExpression = expr.expression;
        const trimmedOriginal = originalExpression.trim();
        if (trimmedOriginal === "") {
            transformedExpression = "_this.";
            wasThisPrepended = true;
            connection.console.log(`[Virtual Gen] Empty original mapped to -> "${transformedExpression}"`);
        }
        else {
            transformedExpression = originalExpression; // Start with original
            connection.console.log(`[Virtual Gen] Transforming members in: "${originalExpression}"`);
            connection.console.log(`[Virtual Gen] Using memberNames: [${memberNames.join(', ')}]`);
            // --- Single Pass Transformation --- 
            // Regex to find all potential standalone identifiers
            const identifierRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
            transformedExpression = transformedExpression.replace(identifierRegex, (match, capturedIdentifier, offset, fullString) => {
                const charBefore = offset > 0 ? fullString[offset - 1] : null;
                connection.console.log(`  - Identifier Check: match=\'${match}\', identifier=\'${capturedIdentifier}\', offset=${offset}, charBefore=\'${charBefore}\'`);
                // Skip if already preceded by a dot
                if (charBefore === '.') {
                    connection.console.log(`    Skipping replacement (preceded by '.')`);
                    return match;
                }
                // Check if the captured identifier is a known member name
                if (memberNames.includes(capturedIdentifier)) {
                    const replacement = `_this.${capturedIdentifier}`;
                    connection.console.log(`    Replacing member -> '${replacement}'`);
                    wasThisPrepended = true;
                    return replacement;
                }
                else {
                    // Not a known member name (e.g., Date, Math, local vars), return original match
                    connection.console.log(`    Skipping replacement (not a known member)`);
                    return match;
                }
            });
            // --- End Single Pass Transformation --- 
            connection.console.log(`[Virtual Gen] Final transformed expression -> "${transformedExpression}"`);
        }
        // --- END TRANSFORMATION LOGIC ---
        // Construct the line: const ___expr_N = (transformed_expression);
        const linePrefix = `const ${placeholderVarName} = (`;
        const lineSuffix = `);\n`;
        const lineContent = linePrefix + transformedExpression + lineSuffix;
        const lineStartOffset = currentOffset;
        const lineEndOffset = lineStartOffset + lineContent.length;
        const valueStartInLine = linePrefix.length;
        const valueEndInLine = valueStartInLine + transformedExpression.length;
        const absoluteValueStart = lineStartOffset + valueStartInLine;
        const absoluteValueEnd = lineStartOffset + valueEndInLine;
        virtualContent += lineContent;
        detailedMappings.push({
            htmlStart: expr.start,
            htmlEnd: expr.end,
            blockStart: lineStartOffset,
            blockEnd: lineEndOffset,
            valueStart: absoluteValueStart,
            valueEnd: absoluteValueEnd,
            wasThisPrepended: wasThisPrepended,
            endsWithPendingTerm: false // Explicitly false for this structure
        });
        currentOffset = lineEndOffset;
        exprIndex++;
    }
    const version = (virtualFiles.get(virtualFileUri)?.version ?? 0) + 1;
    connection.console.log(`[updateVirtualFile] Setting VIRTUAL content for ${virtualFileUri}:\n---\n${virtualContent}\n---`);
    virtualFiles.set(virtualFileUri, { content: virtualContent, version });
    mappings.set(htmlUri, { mappings: detailedMappings, memberNames });
}
function mapCompletionKind(kind) {
    const kindMap = {
        [ts.ScriptElementKind.primitiveType]: node_1.CompletionItemKind.Keyword,
        [ts.ScriptElementKind.variableElement]: node_1.CompletionItemKind.Variable,
        [ts.ScriptElementKind.functionElement]: node_1.CompletionItemKind.Function,
        [ts.ScriptElementKind.memberVariableElement]: node_1.CompletionItemKind.Property,
        [ts.ScriptElementKind.memberFunctionElement]: node_1.CompletionItemKind.Method,
        [ts.ScriptElementKind.keyword]: node_1.CompletionItemKind.Keyword, // Added keyword
    };
    return kindMap[kind];
}
// Function to explicitly check if a file exists
function fileExistsOnDisk(filePath) {
    try {
        return ts.sys.fileExists(filePath);
    }
    catch (e) {
        connection.console.error(`[fileExistsOnDisk] Error checking ${filePath}: ${e}`);
        return false;
    }
}
// Function to create/recreate the language service
function createLanguageServiceInstance(documents, virtualFiles, workspaceRoot) {
    // --- tsconfig.json discovery and parsing ---
    let compilerOptions = {};
    const configFileName = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, "tsconfig.json");
    if (configFileName) {
        connection.console.log(`[createLanguageServiceInstance] Found tsconfig.json at: ${configFileName}`);
        const configFile = ts.readConfigFile(configFileName, ts.sys.readFile);
        if (configFile.error) {
            connection.console.error(`[createLanguageServiceInstance] Error reading tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
        }
        else {
            const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configFileName), {
                strict: strictMode,
                noImplicitAny: strictMode,
                strictNullChecks: strictMode,
                target: ts.ScriptTarget.ESNext, // Default to ESNext, tsconfig can override
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.NodeJs,
                esModuleInterop: true,
                allowJs: true,
                allowSyntheticDefaultImports: true,
                baseUrl: workspaceRoot, // Base URL can be overridden by tsconfig
            }, configFileName);
            if (parsedConfig.errors.length > 0) {
                connection.console.warn(`[createLanguageServiceInstance] Errors parsing tsconfig.json:`);
                parsedConfig.errors.forEach(error => {
                    connection.console.warn(`  - ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
                });
                // Use default options even if tsconfig has errors? Or use partially parsed?
                // Let's use the parsed options for now, TS is usually resilient.
                compilerOptions = parsedConfig.options;
            }
            else {
                compilerOptions = parsedConfig.options;
                connection.console.log(`[createLanguageServiceInstance] Successfully parsed tsconfig.json.`);
            }
            // --- Ensure essential options --- 
            // We might want to enforce certain options regardless of tsconfig
            // For example, ensuring module resolution is suitable for LSP
            compilerOptions.moduleResolution = ts.ModuleResolutionKind.NodeJs; // Or Bundler if using newer TS
            compilerOptions.allowJs = true; // Important for mixed projects
            // compilerOptions.maxNodeModuleJsDepth = 2; // Consider limiting JS scan depth
        }
    }
    else {
        connection.console.log(`[createLanguageServiceInstance] No tsconfig.json found in workspace. Using default compiler options.`);
        // Define default compiler options if tsconfig is not found
        compilerOptions = {
            strict: strictMode,
            noImplicitAny: strictMode,
            strictNullChecks: strictMode,
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            esModuleInterop: true,
            allowJs: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            baseUrl: workspaceRoot,
            allowSyntheticDefaultImports: true,
            // Optional: Add path mappings if useful as a default
            // paths: { "*": ["*", "src/*", "app/*"] } 
        };
    }
    // Log the final effective compiler options
    connection.console.log(`[createLanguageServiceInstance] Effective CompilerOptions: ${JSON.stringify(compilerOptions, null, 2)}`);
    // Keep track of all files we've seen
    const allTsFiles = new Set();
    // Collect all .ts files to help with module resolution
    function scanTsFiles(directory, result) {
        try {
            const entries = ts.sys.readDirectory(directory);
            for (const entry of entries) {
                const fullPath = path.join(directory, entry);
                if (entry === 'node_modules' || entry.startsWith('.'))
                    continue;
                let isDirectory = false;
                try {
                    isDirectory = ts.sys.directoryExists(fullPath);
                }
                catch (e) { /* ignore errors checking non-dirs */ }
                if (isDirectory) {
                    scanTsFiles(fullPath, result);
                }
                else if (entry.endsWith('.ts') || entry.endsWith('.d.ts')) {
                    result.add(vscode_uri_1.URI.file(fullPath).toString());
                }
            }
        }
        catch (e) {
            connection.console.error(`Error scanning directory ${directory}: ${e}`);
        }
    }
    // Scan the workspace - TODO: Potentially use parsedConfig.fileNames from tsconfig if available?
    scanTsFiles(workspaceRoot, allTsFiles);
    connection.console.log(`[createLanguageServiceInstance] Scanned ${allTsFiles.size} TypeScript files in workspace`);
    const host = {
        getScriptFileNames: () => {
            const fileUris = new Set();
            // 1. Add open documents
            documents.keys().forEach(uri => fileUris.add(uri));
            // 2. Add virtual files
            for (const virtualUri of virtualFiles.keys()) {
                fileUris.add(virtualUri);
            }
            // 3. Add all known TS files (Consider using parsedConfig.fileNames if tsconfig was used)
            allTsFiles.forEach(uri => fileUris.add(uri));
            connection.console.log(`[getScriptFileNames] Total files provided: ${fileUris.size}`);
            return Array.from(fileUris);
        },
        getScriptVersion: (fileName) => {
            if (documents.get(fileName)) {
                return documents.get(fileName).version.toString();
            }
            else if (virtualFiles.has(fileName)) {
                return virtualFiles.get(fileName).version.toString();
            }
            // Check file modification time for non-open/non-virtual files?
            // For simplicity, return '0', relying on TS to handle changes.
            return '0';
        },
        getScriptSnapshot: (fileName) => {
            // 1. Check open documents
            const openDoc = documents.get(fileName);
            if (openDoc) {
                return ts.ScriptSnapshot.fromString(openDoc.getText());
            }
            // 2. Check virtual files
            const virtualFile = virtualFiles.get(fileName);
            if (virtualFile) {
                return ts.ScriptSnapshot.fromString(virtualFile.content);
            }
            // 3. Try reading from disk
            let fsPath = fileName;
            try {
                if (fileName.startsWith('file:///')) {
                    fsPath = vscode_uri_1.URI.parse(fileName).fsPath;
                }
            }
            catch (e) { /* Ignore URI parse errors */ }
            // Use host.fileExists which checks virtualFiles too
            if (host.fileExists(fsPath)) {
                try {
                    const content = ts.sys.readFile(fsPath); // Use ts.sys consistently?
                    if (content !== undefined) {
                        return ts.ScriptSnapshot.fromString(content);
                    }
                }
                catch (e) {
                    connection.console.error(`[getScriptSnapshot] Error reading ${fsPath} from disk: ${e}`);
                }
            }
            return undefined;
        },
        getCurrentDirectory: () => workspaceRoot,
        getCompilationSettings: () => compilerOptions, // Use the determined compiler options
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        fileExists: (fileName) => {
            // Enhanced fileExists to check virtual files too
            if (virtualFiles.has(fileName)) {
                return true;
            }
            // Check actual disk file existence
            let fsPath = fileName;
            try {
                if (fileName.startsWith('file:///')) {
                    fsPath = vscode_uri_1.URI.parse(fileName).fsPath;
                }
            }
            catch { }
            return fileExistsOnDisk(fsPath); // Use our helper
        },
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        // Additional resolver settings
        resolveModuleNames: (moduleNames, containingFile, _reusedNames, _redirectedReference, options) => {
            const currentCompilerOptions = host.getCompilationSettings();
            connection.console.log(`[resolveModuleNames] Resolving ${moduleNames.length} modules for ${containingFile}`);
            return moduleNames.map(moduleName => {
                connection.console.log(` --> [resolveModuleNames] Attempting to resolve module '${moduleName}' from containing file '${containingFile}'`);
                // Try standard TypeScript resolution first
                const result = ts.resolveModuleName(moduleName, containingFile, currentCompilerOptions, {
                    fileExists: host.fileExists,
                    readFile: host.readFile
                });
                if (result.resolvedModule) {
                    connection.console.log(` --> [resolveModuleNames] Standard resolution SUCCESS: '${moduleName}' resolved to '${result.resolvedModule.resolvedFileName}' (isExternal: ${result.resolvedModule.isExternalLibraryImport})`);
                    return result.resolvedModule;
                }
                else {
                    connection.console.log(` --> [resolveModuleNames] Standard resolution FAILED for '${moduleName}'.`);
                }
                // Custom resolution logic (might not be needed if tsconfig handles paths correctly)
                connection.console.log(` --> [resolveModuleNames] Trying custom fallback resolution for '${moduleName}'...`);
                let containingDir;
                try {
                    containingDir = path.dirname(containingFile.startsWith('file:///') ? vscode_uri_1.URI.parse(containingFile).fsPath : containingFile);
                }
                catch (e) {
                    connection.console.error(`[resolveModuleNames] Error parsing containing file path: ${containingFile}, Error: ${e}`);
                    return undefined; // Cannot resolve without a valid directory
                }
                const extensions = ['.ts', '.js', '.d.ts', '/index.ts', '/index.js', '/index.d.ts'];
                for (const ext of extensions) {
                    const potentialPath = path.resolve(containingDir, moduleName + ext);
                    if (host.fileExists(potentialPath)) {
                        connection.console.log(` --> [resolveModuleNames] Custom resolution SUCCESS: Found '${moduleName}' at '${potentialPath}'`);
                        return {
                            resolvedFileName: potentialPath,
                            extension: ts.Extension.Ts, // Assuming TS primarily
                            isExternalLibraryImport: potentialPath.includes('node_modules'),
                        };
                    }
                }
                connection.console.log(` --> [resolveModuleNames] Custom resolution FAILED for '${moduleName}'.`);
                return undefined;
            });
        }
    };
    return ts.createLanguageService(host);
}
connection.onInitialize((params) => {
    workspaceRoot = params.rootUri ? vscode_uri_1.URI.parse(params.rootUri).fsPath : params.rootPath || process.cwd();
    languageService = createLanguageServiceInstance(documents, virtualFiles, workspaceRoot);
    connection.console.log("[Initialize] Language service created.");
    const result = {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ['.']
            },
            definitionProvider: true // Add definition provider capability
        },
    };
    connection.console.log(`[Initialize] Server capabilities: ${JSON.stringify(result.capabilities)}`);
    return result;
});
documents.onDidOpen(event => {
    connection.console.log(`[onDidOpen] Document opened: ${event.document.uri}`);
    if (event.document.uri.endsWith('.html')) {
        // Just update virtual file
        updateVirtualFile(event.document.uri, event.document.getText());
    }
});
documents.onDidChangeContent((change) => {
    const uri = change.document.uri;
    if (uri.endsWith('.html')) {
        connection.console.log(`[onDidChangeContent] HTML document changed: ${uri}`);
        updateVirtualFile(uri, change.document.getText());
    }
    else if (uri.endsWith('.ts') && !uri.includes('.virtual.')) {
        // If a TS file changes, just update open HTML files' virtual content
        connection.console.log(`[onDidChangeContent] TS file changed: ${uri}. Updating virtual files.`);
        for (const doc of documents.all()) {
            if (doc.uri.endsWith('.html')) {
                updateVirtualFile(doc.uri, doc.getText());
            }
        }
    }
});
connection.onDidChangeConfiguration((params) => {
    const settings = params.settings;
    strictMode = settings.aureliaLsp?.strictMode ?? false;
    // Recreate service or update settings - Recreating is simpler for now
    languageService = createLanguageServiceInstance(documents, virtualFiles, workspaceRoot);
    // Force regeneration of virtual files
    for (const [uri] of virtualFiles) {
        const doc = documents.get(uri.replace('.virtual.ts', ''));
        if (doc) {
            updateVirtualFile(doc.uri, doc.getText());
        }
    }
});
// --- Completion Logic (Standard, NO Simulation) ---
connection.onCompletion((params) => {
    const uri = params.textDocument.uri;
    if (!uri.endsWith('.html'))
        return [];
    const document = documents.get(uri);
    if (!document)
        return [];
    const offset = document.offsetAt(params.position);
    const virtualFileUri = uri + '.virtual.ts';
    const currentVirtualFile = virtualFiles.get(virtualFileUri);
    if (!currentVirtualFile) {
        connection.console.log(`[onCompletion] Virtual file not found: ${virtualFileUri}`);
        return [];
    }
    const currentVirtualContent = currentVirtualFile.content;
    connection.console.log(`[onCompletion] Analyzing Virtual File Content (${virtualFileUri}):\n---\n${currentVirtualContent}\n---`);
    const expressionMappings = mappings.get(uri);
    if (!expressionMappings) {
        connection.console.log(`[onCompletion] No mappings found for ${uri}`);
        return [];
    }
    // Find the mapping for the current HTML offset
    let activeMapping;
    for (const mapping of expressionMappings.mappings) {
        if (mapping.htmlStart <= offset && offset <= mapping.htmlEnd) {
            activeMapping = mapping;
            break;
        }
    }
    if (!activeMapping) {
        connection.console.log(`[onCompletion] Offset ${offset} not within any mapped expression.`);
        return [];
    }
    connection.console.log(`[onCompletion] Found active mapping for HTML offset ${offset}: ${JSON.stringify(activeMapping)}`);
    // --- REVISED Offset Calculation v4 --- 
    const relativeHtmlOffset = offset - activeMapping.htmlStart;
    let virtualCompletionOffset;
    const originalHtmlExpression = document.getText().substring(activeMapping.htmlStart, activeMapping.htmlEnd);
    if (originalHtmlExpression.trim() === "") {
        virtualCompletionOffset = activeMapping.valueEnd;
        connection.console.log(`[onCompletion] Offset Calc: Empty original HTML -> using valueEnd: ${virtualCompletionOffset}`);
    }
    else if (activeMapping.wasThisPrepended) {
        // If "_this." was potentially added virtually. Map cursor relative to corresponding identifier.
        // The virtual identifier starts 6 chars after valueStart (_this.)
        virtualCompletionOffset = activeMapping.valueStart + 6 + relativeHtmlOffset;
        connection.console.log(`[onCompletion] Offset Calc: wasThisPrepended=true. Initial calculated offset: ${virtualCompletionOffset} (based on relativeHtml=${relativeHtmlOffset})`);
    }
    else {
        virtualCompletionOffset = activeMapping.valueStart + relativeHtmlOffset;
        connection.console.log(`[onCompletion] Offset Calc: Standard mapping. Initial calculated offset: ${virtualCompletionOffset} (based on relativeHtml=${relativeHtmlOffset})`);
    }
    // Clamp final offset within the virtual value range
    virtualCompletionOffset = Math.max(activeMapping.valueStart, Math.min(virtualCompletionOffset, activeMapping.valueEnd));
    connection.console.log(`[onCompletion] Offset Calc: Final Clamped Offset: ${virtualCompletionOffset}`);
    // --- END REVISED OFFSET CALCULATION --- 
    connection.console.log(`[onCompletion] Requesting completions at final VIRTUAL offset: ${virtualCompletionOffset}`);
    // Get completions 
    const completions = languageService.getCompletionsAtPosition(virtualFileUri, virtualCompletionOffset, {});
    // --- DETAILED LOGGING: Log ALL raw completions from TS --- 
    if (!completions) {
        connection.console.log("[onCompletion] TS returned null/undefined completions object.");
        return []; // Return empty if TS gave nothing
    }
    else {
        connection.console.log(`[onCompletion] Raw completions received (${completions.entries.length} total):`);
        // Log the first ~50 raw entries for inspection
        completions.entries.slice(0, 50).forEach((entry, index) => {
            connection.console.log(`  - Raw[${index}]: Name=${entry.name}, Kind=${entry.kind}, Modifiers=${entry.kindModifiers}`);
        });
    }
    // --- END DETAILED LOGGING ---
    // Define desired kinds - EXPANDED to include classes, etc.
    const desiredKinds = [
        ts.ScriptElementKind.memberVariableElement,
        ts.ScriptElementKind.memberFunctionElement,
        ts.ScriptElementKind.memberGetAccessorElement,
        ts.ScriptElementKind.memberSetAccessorElement,
        ts.ScriptElementKind.variableElement, // Locals and potentially globals
        ts.ScriptElementKind.constElement, // Locals
        ts.ScriptElementKind.letElement, // Locals
        ts.ScriptElementKind.functionElement, // Local Functions
        ts.ScriptElementKind.classElement, // <<< ADDED: Globals like Date, Promise
        ts.ScriptElementKind.interfaceElement, // <<< ADDED: Interfaces
        ts.ScriptElementKind.typeElement, // <<< ADDED: Type aliases
        ts.ScriptElementKind.enumElement, // <<< ADDED: Enums
        // ts.ScriptElementKind.moduleElement,    // Maybe? Might be too noisy
        // ts.ScriptElementKind.externalModuleName, // Maybe?
        ts.ScriptElementKind.keyword // Keep keywords
    ];
    // --- Prepare for potential fallback ---
    const actualExpressionText = document.getText().substring(activeMapping.htmlStart, activeMapping.htmlEnd);
    const textBeforeCursor = actualExpressionText.substring(0, offset - activeMapping.htmlStart);
    const trimmedTextBeforeCursor = textBeforeCursor.trimEnd();
    // --- REVISED needsThisFallback --- 
    // Context needs 'this.' prepended IF:
    // - We are at the start of the expression (or only whitespace before cursor)
    // - OR the text before ends in an operator/punctuator that expects a term
    // - AND it doesn't already end with '.' or 'this.'
    // - AND it doesn't end with a keyword like 'new' that expects a type/constructor
    const endsWithDotOrThis = trimmedTextBeforeCursor.endsWith('.') || trimmedTextBeforeCursor.endsWith('this.');
    const endsWithTermExpectingOperator = /([+\-*/%&|^<>=!~({[?,:]|\b(?:instanceof|in|of)\b)\s*$/.test(trimmedTextBeforeCursor);
    const endsWithNewOrSimilar = /\b(?:new|typeof|delete|void|await|yield|case|return|throw)\s*$/.test(trimmedTextBeforeCursor); // Keywords expecting non-member value
    const atStartOfExpression = trimmedTextBeforeCursor === '';
    const needsThisFallback = !endsWithDotOrThis &&
        !endsWithNewOrSimilar &&
        (atStartOfExpression || endsWithTermExpectingOperator);
    connection.console.log(`[onCompletion] Context check: textBefore='${textBeforeCursor}', endsDotOrThis=${endsWithDotOrThis}, endsNewEtc=${endsWithNewOrSimilar}, endsOperator=${endsWithTermExpectingOperator}, atStart=${atStartOfExpression} => needsThisFallback=${needsThisFallback}`);
    // --- END REVISED --- 
    const viewModelMemberNames = expressionMappings.memberNames; // Get members from mapping info
    // --- Initial Filtering - REVISED --- 
    let result = completions.entries
        .filter(entry => {
        // Always filter internal helpers
        if (entry.name.startsWith('___')) {
            return false;
        }
        // Basic Keyword Filtering: Allow keywords unless context strongly forbids
        // (This is tricky without full parsing, let's be permissive for now)
        // Example: Don't suggest `if` right after `this.`
        // if (entry.kind === ts.ScriptElementKind.keyword) {
        //   if (textBeforeCursor.trimEnd().endsWith('.')) { return false; } // Very basic check
        // }
        // Keep if the kind is in our desired list
        return desiredKinds.includes(entry.kind);
    })
        .map(entry => {
        // --- REVISED Sort Priority --- 
        let sortPriority = '9'; // Default lowest priority
        const kind = entry.kind;
        // Check if it's a known ViewModel member
        const isMember = [
            ts.ScriptElementKind.memberVariableElement,
            ts.ScriptElementKind.memberFunctionElement,
            ts.ScriptElementKind.memberGetAccessorElement,
            ts.ScriptElementKind.memberSetAccessorElement,
        ].includes(kind) && viewModelMemberNames.includes(entry.name);
        if (isMember) {
            sortPriority = '0'; // Highest: Properties/Methods from VM
        }
        else if ([
            ts.ScriptElementKind.variableElement,
            ts.ScriptElementKind.constElement,
            ts.ScriptElementKind.letElement,
        ].includes(kind)) {
            sortPriority = '1'; // High: Local Variables/Constants
        }
        else if (kind === ts.ScriptElementKind.functionElement) {
            sortPriority = '2'; // Medium-High: Local/Global Functions
        }
        else if ([
            ts.ScriptElementKind.classElement,
            ts.ScriptElementKind.interfaceElement,
            ts.ScriptElementKind.typeElement,
            ts.ScriptElementKind.enumElement
        ].includes(kind)) {
            sortPriority = '3'; // Medium: Classes, Types, Interfaces, Enums (like Date)
        }
        else if (kind === ts.ScriptElementKind.keyword) {
            sortPriority = '4'; // Lower: Keywords
        }
        else {
            sortPriority = '5'; // Other things
        }
        const resultItem = {
            label: entry.name,
            kind: mapCompletionKind(entry.kind),
            insertText: entry.name, // Always use original name here
            detail: entry.kind,
            sortText: sortPriority,
            data: { isViewModelMember: isMember } // <<< ADD data property
        };
        connection.console.log(`  - Mapping Item: Label=${resultItem.label}, Kind=${entry.kind}, Insert=${resultItem.insertText}, SortText=${resultItem.sortText}, IsMember=${isMember}`);
        return resultItem;
    });
    // --- Fallback Logic - REVISED TO ADD, NOT REPLACE --- 
    if (needsThisFallback && !result.some(item => item.data?.isViewModelMember)) {
        connection.console.log(`[onCompletion] Initial completions lack VM members and context needs 'this.'. Trying fallback...`);
        const fallbackCompletions = languageService.getCompletionsAtPosition(virtualFileUri, activeMapping.valueStart, // Get completions at the start of the value expression (context of 'this')
        {});
        if (fallbackCompletions) {
            // Filter fallback: Only keep known VM members
            const fallbackResult = fallbackCompletions.entries
                .filter(entry => {
                const kind = entry.kind;
                const isMemberKind = [
                    ts.ScriptElementKind.memberVariableElement,
                    ts.ScriptElementKind.memberFunctionElement,
                    ts.ScriptElementKind.memberGetAccessorElement,
                    ts.ScriptElementKind.memberSetAccessorElement,
                ].includes(kind);
                return isMemberKind && viewModelMemberNames.includes(entry.name);
            })
                .map(entry => {
                const kind = entry.kind;
                const sortPriority = '0';
                const fallbackItem = {
                    label: `_this.${entry.name}`, // <<< Use _this.
                    kind: mapCompletionKind(entry.kind),
                    insertText: `_this.${entry.name}`, // <<< Use _this.
                    detail: `(member) ${entry.kind}`,
                    sortText: sortPriority,
                    data: { isViewModelMember: true }
                };
                connection.console.log(`  - Fallback Mapping: Label=${fallbackItem.label}, Kind=${entry.kind}, Insert=${fallbackItem.insertText}, SortText=${fallbackItem.sortText}`);
                return fallbackItem;
            });
            if (fallbackResult.length > 0) {
                connection.console.log(`[onCompletion Fallback] Adding ${fallbackResult.length} fallback completions.`);
                // Add fallback items to the *beginning* of the results for higher priority?
                result = [...fallbackResult, ...result];
            }
            else {
                connection.console.log("[onCompletion Fallback] Filtered fallback list was empty.");
            }
        }
        else {
            connection.console.log("[onCompletion Fallback] TS returned no fallback completions.");
        }
    }
    connection.console.log(`[onCompletion] Returning final ${result.length} completions.`);
    result.slice(0, 10).forEach(item => connection.console.log(`  - Filtered: ${item.label} (Kind: ${item.detail})`));
    return result;
});
// --- Definition Logic ---
connection.onDefinition(async (params) => {
    connection.console.log(`[onDefinition] Received request for ${params.textDocument.uri} at L${params.position.line} C${params.position.character}`);
    const uri = params.textDocument.uri;
    if (!uri.endsWith('.html'))
        return undefined;
    const document = documents.get(uri);
    if (!document) {
        connection.console.log('[onDefinition] Document not found in cache.');
        return undefined;
    }
    const offset = document.offsetAt(params.position);
    connection.console.log(`[onDefinition] Calculated HTML offset: ${offset}`);
    const virtualFileUri = uri + '.virtual.ts';
    const currentVirtualFile = virtualFiles.get(virtualFileUri);
    if (!currentVirtualFile) {
        connection.console.log(`[onDefinition] Virtual file not found: ${virtualFileUri}`);
        return undefined;
    }
    // Log virtual content around the expected area for context (optional, can be large)
    // const potentialStart = Math.max(0, activeMapping.valueStart - 20);
    // const potentialEnd = activeMapping.valueEnd + 20;
    // connection.console.log(`[onDefinition] Virtual content slice: ...${currentVirtualFile.content.substring(potentialStart, potentialEnd)}...`);
    const mappingInfo = mappings.get(uri);
    if (!mappingInfo || !mappingInfo.mappings) {
        connection.console.log(`[onDefinition] No mappings found for ${uri}`);
        return undefined;
    }
    // Find the active mapping for the HTML offset
    let activeMapping;
    for (const mapping of mappingInfo.mappings) {
        if (mapping.htmlStart <= offset && offset <= mapping.htmlEnd) {
            activeMapping = mapping;
            break;
        }
    }
    if (!activeMapping) {
        connection.console.log(`[onDefinition] Offset ${offset} not within any mapped expression.`);
        return undefined;
    }
    connection.console.log(`[onDefinition] Found active mapping: ${JSON.stringify(activeMapping)}`);
    // Calculate the virtual offset (where to ask TS for definitions)
    const relativeHtmlOffsetForCursor = offset - activeMapping.htmlStart;
    const originalHtmlExpression = document.getText().substring(activeMapping.htmlStart, activeMapping.htmlEnd);
    connection.console.log(`[onDefinition] cursorRelativeHtmlOffset=${relativeHtmlOffsetForCursor}, originalHtmlExpression='${originalHtmlExpression}', wasThisPrepended=${activeMapping.wasThisPrepended}`);
    let virtualOffset;
    if (originalHtmlExpression.trim() === '') {
        // Empty expression -> return (this.) -> position cursor after the dot
        virtualOffset = activeMapping.valueEnd;
        connection.console.log(`[onDefinition] Empty original expression. virtualOffset set to valueEnd: ${virtualOffset}`);
    }
    else if (activeMapping.wasThisPrepended) {
        // 'this.' was prepended -> return (this.member) 
        // Place cursor reliably *after* 'this.' (at valueStart + 5) plus the relative cursor offset within the original identifier
        const relativeOffsetWithinOriginal = Math.max(0, offset - activeMapping.htmlStart); // Offset relative to start of original HTML identifier
        virtualOffset = activeMapping.valueStart + 5 + relativeOffsetWithinOriginal;
        // Ensure we don't go past the end of the mapped value range
        virtualOffset = Math.min(virtualOffset, activeMapping.valueEnd);
        connection.console.log(`[onDefinition] 'this.' prepended. Calculated virtualOffset: ${virtualOffset} (based on relative ${relativeOffsetWithinOriginal})`);
    }
    else {
        // Standard case: map HTML offset directly into virtual value range
        virtualOffset = Math.max(activeMapping.valueStart, Math.min(activeMapping.valueStart + relativeHtmlOffsetForCursor, activeMapping.valueEnd));
        connection.console.log(`[onDefinition] Standard mapping. Calculated virtualOffset: ${virtualOffset}`);
    }
    connection.console.log(`[onDefinition] Requesting definition from TS at final VIRTUAL offset: ${virtualOffset}`);
    // Get definition from the language service
    const definitions = languageService.getDefinitionAndBoundSpan(virtualFileUri, virtualOffset);
    // Log the raw response from TS immediately
    connection.console.log(`[onDefinition] Raw definitions object from TS: ${JSON.stringify(definitions, null, 2)}`);
    if (!definitions || !definitions.definitions || definitions.definitions.length === 0) {
        connection.console.log("[onDefinition] TS returned no definitions or empty definitions array.");
        return undefined;
    }
    const locationLinks = [];
    const program = languageService.getProgram();
    if (!program) {
        connection.console.warn("[onDefinition] Could not get program to map definitions.");
        return undefined;
    }
    // --- REVISED: Calculate the origin span (HTML highlighting) --- 
    const originVirtualSpan = definitions.textSpan; // The span TS identified in the virtual file
    const originVirtualStart = originVirtualSpan.start;
    const originVirtualLength = originVirtualSpan.length;
    connection.console.log(`[onDefinition] Origin span from TS (virtual file): start=${originVirtualStart}, length=${originVirtualLength}`);
    // Calculate the start offset within the virtual expression (relative to valueStart)
    const relativeVirtualStartOffset = originVirtualStart - activeMapping.valueStart;
    connection.console.log(`[onDefinition] Relative virtual start offset: ${relativeVirtualStartOffset}`);
    // Calculate the corresponding relative offset in the *original* HTML expression
    let relativeHtmlStartOffset;
    if (activeMapping.wasThisPrepended) {
        // If "." was added (e.g. from _this.). Adjust offset by 6 chars.
        relativeHtmlStartOffset = Math.max(0, relativeVirtualStartOffset - 6);
        connection.console.log(`[onDefinition] Adjusting relative HTML start offset due to prepended ".": ${relativeHtmlStartOffset}`);
    }
    else {
        // If no transformation added ".", the relative offsets map directly
        relativeHtmlStartOffset = relativeVirtualStartOffset;
        connection.console.log(`[onDefinition] No prepend adjustment needed for relative HTML start offset.`);
    }
    // Calculate the absolute HTML start position
    const originHtmlStart = activeMapping.htmlStart + relativeHtmlStartOffset;
    connection.console.log(`[onDefinition] Calculated absolute originHtmlStart: ${originHtmlStart}`);
    // Calculate the HTML end position using the length from the TS span
    // Ensure the length doesn't exceed the original HTML expression boundary
    const originHtmlLength = Math.min(originVirtualLength, activeMapping.htmlEnd - originHtmlStart);
    const originHtmlEnd = originHtmlStart + originHtmlLength;
    connection.console.log(`[onDefinition] Calculated absolute originHtmlEnd: ${originHtmlEnd} (using length: ${originHtmlLength})`);
    const originSelectionRange = node_1.Range.create(document.positionAt(originHtmlStart), document.positionAt(originHtmlEnd));
    connection.console.log(`[onDefinition] Final originSelectionRange (HTML): ${JSON.stringify(originSelectionRange)}`);
    // --- END REVISED CALCULATION ---
    for (const def of definitions.definitions) {
        connection.console.log(`[onDefinition] Processing definition entry: ${JSON.stringify(def)}`);
        // Skip definitions pointing back to the virtual file itself
        if (def.fileName === virtualFileUri) {
            connection.console.log(`[onDefinition] Skipping definition within virtual file: ${def.fileName}`);
            continue;
        }
        // Use the fileName directly if it's already a file URI, otherwise convert from path
        const targetUri = def.fileName.startsWith('file:///')
            ? def.fileName
            : vscode_uri_1.URI.file(def.fileName).toString();
        connection.console.log(`[onDefinition] Target URI: ${targetUri}`);
        const targetSourceFile = program.getSourceFile(def.fileName);
        if (!targetSourceFile) {
            connection.console.warn(`[onDefinition] Could not get source file for definition target: ${def.fileName}`);
            continue;
        }
        const targetStartPos = targetSourceFile.getLineAndCharacterOfPosition(def.textSpan.start);
        const targetEndPos = targetSourceFile.getLineAndCharacterOfPosition(def.textSpan.start + def.textSpan.length);
        connection.console.log(`[onDefinition] Target span from TS (target file): start=${def.textSpan.start}, length=${def.textSpan.length}. Mapped to Line/Char: Start=${targetStartPos.line}/${targetStartPos.character}, End=${targetEndPos.line}/${targetEndPos.character}`);
        const targetRange = node_1.Range.create(targetStartPos.line, targetStartPos.character, targetEndPos.line, targetEndPos.character);
        // Define a selection range that *only* covers the start position
        const targetSelectionRange = node_1.Range.create(targetStartPos.line, targetStartPos.character, targetStartPos.line, targetStartPos.character);
        connection.console.log(`[onDefinition] Final Target FullRange=${JSON.stringify(targetRange)} SelectionRange=${JSON.stringify(targetSelectionRange)}`);
        locationLinks.push(node_1.LocationLink.create(targetUri, targetRange, targetSelectionRange, originSelectionRange) // Use specific selection range
        );
    }
    connection.console.log(`[onDefinition] Returning ${locationLinks.length} mapped LocationLinks.`);
    return locationLinks;
});
// --- Server Listen ---
connection.listen();
documents.listen(connection);
//# sourceMappingURL=server.js.map