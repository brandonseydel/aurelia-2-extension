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
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode_1 = require("vscode");
const fs = __importStar(require("fs")); // Import fs for reading package.json
const ts = __importStar(require("typescript")); // Import TS for AST parsing
const node_1 = require("vscode-languageclient/node");
let client;
// Helper function to convert kebab-case to PascalCase
function kebabToPascalCase(str) {
    return str
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}
// Helper function to convert PascalCase or camelCase to kebab-case
function toKebabCase(str) {
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2') // Get all lowercase letters that are near to uppercase ones
        .replace(/[\s_]+/g, '-') // Replace spaces and underscores with a hyphen
        .toLowerCase();
}
// --- Remove Placeholder Logging ---
// const log = { ... };
function activate(context) {
    console.log('--- Activating Aurelia Language Client --- ');
    // Get workspace root path
    const workspaceRoot = vscode_1.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        console.error('Cannot activate extension: Workspace root not found.');
        return;
    }
    // The server is implemented in node
    // Construct the absolute path to the server module from the extension path
    // context.extensionPath points to '.../aurelia-2-extension/client'
    // We need to go up one level and then into 'server/out/server.js'
    const serverModule = path.join(context.extensionPath, '..', 'server', 'out', 'server.js');
    console.log(`Server module path (using context.extensionPath + relative): ${serverModule}`);
    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions = {
        run: { module: serverModule, transport: node_1.TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: node_1.TransportKind.ipc,
            options: { execArgv: ['--nolazy', '--inspect=6009'] } // Adjust port if needed
        }
    };
    // Options to control the language client
    const clientOptions = {
        // Register the server for plain html documents
        // We will rely on VS Code's built-in HTML language features for basic HTML,
        // and layer our Aurelia-specific features on top.
        documentSelector: [{ scheme: 'file', language: 'html' }],
        synchronize: {
        // Notify the server about file changes to '.clientrc files contained in the workspace
        // fileEvents: workspace.createFileSystemWatcher('**/.clientrc') // Example configuration watching
        },
        initializationOptions: {
        // Pass any initial settings if needed, but primarily to enable semantic tokens
        // The actual legend will come from the server capabilities 
        }
    };
    // Create the language client and start the client.
    client = new node_1.LanguageClient('aureliaLanguageServer', 'Aurelia Language Server', serverOptions, clientOptions);
    // Start the client. This will also launch the server
    client.start();
    console.log('Aurelia Language Client activated.');
    // --- Register Go To Commands --- 
    const goToHtmlCommand = vscode_1.commands.registerCommand('aurelia.gotoHtml', async () => {
        const editor = vscode_1.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'typescript') {
            return;
        }
        const currentFilePath = editor.document.uri.fsPath;
        const currentDir = path.dirname(currentFilePath);
        const baseName = path.basename(currentFilePath, path.extname(currentFilePath)); // Get filename without extension
        const htmlFileName = `${baseName}.html`;
        const potentialHtmlPath = path.join(currentDir, htmlFileName);
        try {
            // Check if the HTML file exists (more reliable than just constructing path)
            const htmlFiles = await vscode_1.workspace.findFiles(vscode_1.workspace.asRelativePath(potentialHtmlPath), null, 1);
            if (htmlFiles.length > 0) {
                const htmlDoc = await vscode_1.workspace.openTextDocument(htmlFiles[0]);
                await vscode_1.window.showTextDocument(htmlDoc);
            }
            else {
                vscode_1.window.showInformationMessage(`Could not find corresponding HTML file: ${htmlFileName}`);
            }
        }
        catch (error) {
            console.error("Error finding or opening HTML file:", error);
            vscode_1.window.showErrorMessage('Error navigating to HTML file.');
        }
    });
    const goToCustomElementCommand = vscode_1.commands.registerCommand('aurelia.gotoCustomElement', async () => {
        const editor = vscode_1.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'html') {
            return;
        }
        const currentHtmlPath = editor.document.uri.fsPath;
        const currentDir = path.dirname(currentHtmlPath);
        const baseName = path.basename(currentHtmlPath, '.html'); // Get base name without .html
        const tsFileName = `${baseName}.ts`;
        const potentialTsPath = path.join(currentDir, tsFileName);
        try {
            // Search for the corresponding TypeScript file in the same directory
            const tsFiles = await vscode_1.workspace.findFiles(vscode_1.workspace.asRelativePath(potentialTsPath), null, 1);
            if (tsFiles.length > 0) {
                const tsDoc = await vscode_1.workspace.openTextDocument(tsFiles[0]);
                await vscode_1.window.showTextDocument(tsDoc);
            }
            else {
                vscode_1.window.showInformationMessage(`Could not find corresponding definition file: ${tsFileName} in the same directory.`);
            }
        }
        catch (error) {
            console.error("Error finding or opening Custom Element definition:", error);
            vscode_1.window.showErrorMessage('Error navigating to Custom Element definition.');
        }
    });
    context.subscriptions.push(goToHtmlCommand, goToCustomElementCommand);
    // --- Context Key Management --- 
    let isAureliaProject = undefined; // Cache the result
    let rootPackageJsonWatcher;
    let pairedFileWatcher;
    async function checkIsAureliaProject() {
        if (isAureliaProject !== undefined)
            return isAureliaProject;
        console.info('[Context] Checking if workspace is an Aurelia project...');
        isAureliaProject = false; // Default
        const workspaceFolders = vscode_1.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const rootPath = workspaceFolders[0].uri.fsPath;
            const packageJsonPath = path.join(rootPath, 'package.json');
            try {
                if (fs.existsSync(packageJsonPath)) {
                    const packageJsonContent = await fs.promises.readFile(packageJsonPath, 'utf-8');
                    const packageJson = JSON.parse(packageJsonContent);
                    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
                    for (const dep in dependencies) {
                        if (dep.startsWith('@aurelia')) {
                            isAureliaProject = true;
                            console.info('[Context] Aurelia project detected (found @aurelia dependency).');
                            break;
                        }
                    }
                }
                else {
                    console.warn('[Context] Root package.json not found.');
                }
            }
            catch (error) {
                console.error('[Context] Error reading or parsing root package.json:', error);
            }
        }
        if (!isAureliaProject) {
            console.info('[Context] Not detected as an Aurelia project.');
        }
        await vscode_1.commands.executeCommand('setContext', 'aurelia:isAureliaProject', isAureliaProject);
        return isAureliaProject;
    }
    async function updateContextKeys(editor = vscode_1.window.activeTextEditor) {
        const isProject = await checkIsAureliaProject();
        let hasPairedHtml = false;
        let hasPairedTs = false;
        let hasExplicitCE = false; // <<< New key state
        let canBeExplicitCE = false; // <<< New key state
        if (isProject && editor) {
            const document = editor.document;
            const currentFilePath = document.uri.fsPath;
            const currentDir = path.dirname(currentFilePath);
            const baseName = path.basename(currentFilePath, path.extname(currentFilePath));
            if (document.languageId === 'typescript') {
                const potentialHtmlPath = path.join(currentDir, `${baseName}.html`);
                try {
                    const htmlFiles = await vscode_1.workspace.findFiles(vscode_1.workspace.asRelativePath(potentialHtmlPath), null, 1);
                    hasPairedHtml = htmlFiles.length > 0;
                    // If it has a paired HTML, check for CE decorator
                    if (hasPairedHtml) {
                        const fileContent = document.getText();
                        const sourceFile = ts.createSourceFile(document.fileName, fileContent, ts.ScriptTarget.Latest, true);
                        let foundDecorator = false;
                        ts.forEachChild(sourceFile, (node) => {
                            if (ts.isClassDeclaration(node) && ts.canHaveModifiers(node)) {
                                const modifiers = ts.getModifiers(node);
                                if (modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
                                    const decorators = ts.getDecorators(node);
                                    if (decorators) {
                                        for (const decorator of decorators) {
                                            if (ts.isCallExpression(decorator.expression) &&
                                                ts.isIdentifier(decorator.expression.expression) &&
                                                decorator.expression.expression.escapedText === 'customElement') {
                                                foundDecorator = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            if (foundDecorator)
                                return;
                        });
                        hasExplicitCE = foundDecorator;
                        canBeExplicitCE = !foundDecorator; // Can be explicit if not already
                    }
                }
                catch (e) {
                    console.error('[Context] Error checking for paired HTML or CE decorator:', e);
                }
            }
            else if (document.languageId === 'html') {
                const potentialTsPath = path.join(currentDir, `${baseName}.ts`);
                try {
                    const tsFiles = await vscode_1.workspace.findFiles(vscode_1.workspace.asRelativePath(potentialTsPath), null, 1);
                    hasPairedTs = tsFiles.length > 0;
                }
                catch { /* Ignore errors */ }
            }
        }
        console.log(`[Context] Updating keys: isProject=${isProject}, hasPairedHtml=${hasPairedHtml}, hasPairedTs=${hasPairedTs}, hasExplicitCE=${hasExplicitCE}, canBeExplicitCE=${canBeExplicitCE}`);
        await vscode_1.commands.executeCommand('setContext', 'aurelia:hasPairedHtml', hasPairedHtml);
        await vscode_1.commands.executeCommand('setContext', 'aurelia:hasPairedTs', hasPairedTs);
        await vscode_1.commands.executeCommand('setContext', 'aurelia:tsFileHasExplicitCE', hasExplicitCE); // <<< Set new key
        await vscode_1.commands.executeCommand('setContext', 'aurelia:tsFileCanBeExplicitCE', canBeExplicitCE); // <<< Set new key
        // isAureliaProject context is set within checkIsAureliaProject itself
    }
    // Initial checks
    checkIsAureliaProject().then(() => {
        updateContextKeys(vscode_1.window.activeTextEditor);
    });
    // Watch for active editor changes
    context.subscriptions.push(vscode_1.window.onDidChangeActiveTextEditor(editor => {
        console.log('[Context] Active editor changed.');
        updateContextKeys(editor);
    }));
    // Watch root package.json for changes
    if (vscode_1.workspace.workspaceFolders && vscode_1.workspace.workspaceFolders.length > 0) {
        const rootPath = vscode_1.workspace.workspaceFolders[0].uri.fsPath;
        const pattern = new vscode_1.RelativePattern(vscode_1.workspace.workspaceFolders[0], 'package.json');
        rootPackageJsonWatcher = vscode_1.workspace.createFileSystemWatcher(pattern);
        rootPackageJsonWatcher.onDidChange(() => {
            console.info('[Context] Root package.json changed. Re-evaluating project status.');
            isAureliaProject = undefined; // Clear cache
            checkIsAureliaProject().then(() => {
                updateContextKeys(vscode_1.window.activeTextEditor);
            });
        });
        rootPackageJsonWatcher.onDidCreate(() => { });
        rootPackageJsonWatcher.onDidDelete(() => { });
        context.subscriptions.push(rootPackageJsonWatcher);
    }
    // Watch for TS/HTML file creation/deletion/change to update paired status and decorator status
    pairedFileWatcher = vscode_1.workspace.createFileSystemWatcher('**/*.{ts,html}');
    const pairedFileChangeHandler = (uri) => {
        console.log(`[Context] Paired file watcher triggered for: ${uri.fsPath}`);
        const activeEditor = vscode_1.window.activeTextEditor;
        // Only update if the changed file could be the pair of the currently active file OR if the active TS file itself changed
        if (activeEditor) {
            const activeDoc = activeEditor.document;
            const activePath = activeDoc.uri.fsPath;
            const activeDir = path.dirname(activePath);
            const activeBaseName = path.basename(activePath, path.extname(activePath));
            const changedPath = uri.fsPath;
            const changedDir = path.dirname(changedPath);
            const changedBaseName = path.basename(changedPath, path.extname(changedPath));
            // Check if change affects pair OR if the active TS file itself changed (for decorator status)
            if ((activeDir === changedDir && activeBaseName === changedBaseName) ||
                (activePath === changedPath && activeDoc.languageId === 'typescript')) {
                console.info('[Context] Change detected affects active file or its potential pair. Updating context keys.');
                updateContextKeys(activeEditor); // Re-run checks for the current editor
            }
        }
    };
    pairedFileWatcher.onDidChange(pairedFileChangeHandler);
    pairedFileWatcher.onDidCreate(pairedFileChangeHandler);
    pairedFileWatcher.onDidDelete(pairedFileChangeHandler);
    context.subscriptions.push(pairedFileWatcher);
    // --- Watch for Text Document Changes (for unsaved decorator changes) --- 
    let debounceTimer;
    context.subscriptions.push(vscode_1.workspace.onDidChangeTextDocument(event => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            const activeEditor = vscode_1.window.activeTextEditor;
            // Check if the change happened in the currently active TS editor
            if (activeEditor && event.document === activeEditor.document && activeEditor.document.languageId === 'typescript') {
                console.log(`[Context] Debounced text change detected in active TS file: ${event.document.uri.fsPath}`);
                updateContextKeys(activeEditor); // Re-evaluate context, including decorator status
            }
        }, 500); // 500ms debounce
    }));
    // --- Register NEW Commands (Refactored) ---
    const makeExplicitCommand = vscode_1.commands.registerCommand('aurelia.makeElementExplicit', async () => {
        const editor = vscode_1.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'typescript')
            return;
        const document = editor.document;
        const fileContent = document.getText();
        const sourceFile = ts.createSourceFile(document.fileName, fileContent, ts.ScriptTarget.Latest, true);
        const currentDir = path.dirname(document.uri.fsPath);
        const baseName = path.basename(document.uri.fsPath, '.ts');
        try {
            const classNode = findExportedClassNode(sourceFile);
            const importInfo = checkCustomElementImportStatus(sourceFile);
            const className = classNode.name?.getText(sourceFile);
            if (!className) {
                throw new Error('Could not determine class name.');
            }
            // --- Find paired files --- 
            let templateImportName;
            let templateImportPath;
            // No longer need style import names, just paths
            // const styleImportNames: string[] = []; 
            const styleImportPaths = [];
            const potentialHtmlPath = path.join(currentDir, `${baseName}.html`);
            const potentialCssPath = path.join(currentDir, `${baseName}.css`);
            const potentialScssPath = path.join(currentDir, `${baseName}.scss`);
            try {
                const htmlFiles = await vscode_1.workspace.findFiles(vscode_1.workspace.asRelativePath(potentialHtmlPath), null, 1);
                if (htmlFiles.length > 0) {
                    templateImportName = 'template'; // Use fixed name for convention
                    templateImportPath = `./${baseName}.html`;
                }
                const cssFiles = await vscode_1.workspace.findFiles(vscode_1.workspace.asRelativePath(potentialCssPath), null, 1);
                if (cssFiles.length > 0) {
                    // const styleVarName = `styles${styleImportNames.length + 1}`;
                    // styleImportNames.push(styleVarName);
                    styleImportPaths.push(`./${baseName}.css`);
                }
                const scssFiles = await vscode_1.workspace.findFiles(vscode_1.workspace.asRelativePath(potentialScssPath), null, 1);
                if (scssFiles.length > 0) {
                    // const styleVarName = `styles${styleImportNames.length + 1}`;
                    // styleImportNames.push(styleVarName);
                    styleImportPaths.push(`./${baseName}.scss`);
                }
            }
            catch (e) {
                console.warn('[Explicit Command] Error finding paired files:', e);
            }
            // --- End Find Paired Files ---
            const kebabName = toKebabCase(className);
            // --- Build Decorator Argument (using import variable names) --- 
            const decoratorArgParts = [`name: '${kebabName}'`];
            if (templateImportName) {
                decoratorArgParts.push(`template`); // Reference the imported variable
            }
            // <<< Style imports are side-effects, not referenced here >>>
            const decoratorArg = `{ ${decoratorArgParts.join(', ')} }`;
            const decoratorText = `@customElement(${decoratorArg})\n`;
            // --- End Build Decorator Argument --- 
            const edit = new vscode_1.WorkspaceEdit();
            let insertPosOffset = 0; // Default insert position at the top
            // --- Find last import statement to insert after --- 
            let lastImportEnd = 0;
            ts.forEachChild(sourceFile, node => {
                if (ts.isImportDeclaration(node)) {
                    lastImportEnd = node.getEnd();
                }
            });
            if (lastImportEnd > 0) {
                // Insert on the line after the last import
                insertPosOffset = lastImportEnd;
                // Check if we need an extra newline
                const textAfterLastImport = fileContent.substring(lastImportEnd);
                if (!textAfterLastImport.startsWith('\r\n') && !textAfterLastImport.startsWith('\n')) {
                    // We'll add the newline before the first new import line
                }
            }
            else {
                // No imports found, insert at the very top (0,0)
            }
            const importsInsertPosition = document.positionAt(insertPosOffset);
            let newImportsText = '\n'; // Start with newline by default if inserting after existing
            if (insertPosOffset === 0)
                newImportsText = ''; // No leading newline if inserting at top
            // --- Handle Imports --- 
            if (importInfo.needsNewImport) {
                newImportsText += `import { customElement } from '@aurelia/runtime-html';\n`;
            }
            else if (importInfo.needsToAddSpecifier && importInfo.existingImportNode) {
                const importNode = importInfo.existingImportNode;
                const clause = importNode.importClause;
                if (clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                    const existingSpecifiers = clause.namedBindings.elements;
                    const newSpecifierText = 'customElement';
                    let specifierInsertPosOffset;
                    if (existingSpecifiers.length > 0) {
                        specifierInsertPosOffset = existingSpecifiers[existingSpecifiers.length - 1].getEnd();
                    }
                    else {
                        specifierInsertPosOffset = clause.namedBindings.getStart() + 1;
                        const braceText = clause.namedBindings.getText(sourceFile);
                        if (braceText.length > 2 && /^\{\s*\}\s*$/.test(braceText)) {
                            specifierInsertPosOffset = clause.namedBindings.getEnd() - 1;
                        }
                    }
                    const textToInsert = existingSpecifiers.length > 0 ? `, ${newSpecifierText}` : newSpecifierText;
                    // Apply this edit separately as it modifies an existing line
                    edit.insert(document.uri, document.positionAt(specifierInsertPosOffset), textToInsert);
                }
                else {
                    console.warn(`[Explicit Command] Could not add customElement to existing import from ${importInfo.existingModuleName}, adding new import line.`);
                    newImportsText += `import { customElement } from '@aurelia/runtime-html';\n`;
                }
            }
            // Add template/style imports
            if (templateImportName && templateImportPath) {
                newImportsText += `import ${templateImportName} from '${templateImportPath}';\n`;
            }
            // <<< Generate side-effect style imports >>>
            styleImportPaths.forEach((stylePath) => {
                newImportsText += `import '${stylePath}';\n`;
            });
            // Insert all new import lines together
            if (newImportsText.trim().length > 0) {
                // Add extra newline if needed after imports block
                if (insertPosOffset > 0 && !fileContent.substring(insertPosOffset).match(/^\r?\n\s*\S/)) {
                    newImportsText += '\n';
                }
                edit.insert(document.uri, importsInsertPosition, newImportsText);
            }
            // --- End Handle Imports ---
            const classPosition = document.positionAt(classNode.getStart(sourceFile));
            edit.insert(document.uri, classPosition, decoratorText);
            const success = await vscode_1.workspace.applyEdit(edit);
            if (!success) {
                vscode_1.window.showErrorMessage('Failed to apply edit to make element explicit.');
            }
        }
        catch (error) {
            vscode_1.window.showErrorMessage(error.message || 'Failed to make element explicit.');
        }
    });
    const makeImplicitCommand = vscode_1.commands.registerCommand('aurelia.makeElementImplicit', async () => {
        const editor = vscode_1.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'typescript')
            return;
        const document = editor.document;
        const fileContent = document.getText();
        const sourceFile = ts.createSourceFile(document.fileName, fileContent, ts.ScriptTarget.Latest, true);
        const baseName = path.basename(document.uri.fsPath, '.ts');
        try {
            const classNode = findExportedClassNode(sourceFile);
            const decoratorToRemove = findCustomElementDecorator(classNode);
            if (!decoratorToRemove) {
                vscode_1.window.showInformationMessage('@customElement decorator not found.');
                return;
            }
            const edit = new vscode_1.WorkspaceEdit();
            const edits = []; // Store edits to apply them carefully
            // --- 1. Remove Decorator --- 
            const decoratorStart = decoratorToRemove.getStart(sourceFile);
            const decoratorEnd = decoratorToRemove.getEnd();
            let startPos = decoratorStart;
            const textBeforeDecorator = fileContent.substring(0, decoratorStart);
            const lastNewlineBeforeDecorator = textBeforeDecorator.lastIndexOf('\n');
            if (lastNewlineBeforeDecorator !== -1) {
                const whitespaceBetween = textBeforeDecorator.substring(lastNewlineBeforeDecorator + 1);
                if (/^\s*$/.test(whitespaceBetween)) {
                    startPos = lastNewlineBeforeDecorator + 1;
                }
            }
            const rangeToRemoveDecorator = new vscode_1.Range(document.positionAt(startPos), document.positionAt(decoratorEnd));
            edits.push(vscode_1.TextEdit.delete(rangeToRemoveDecorator));
            // --- 2. Find and Remove Associated Imports --- 
            const expectedTemplateImportPath = `./${baseName}.html`;
            const expectedCssImportPath = `./${baseName}.css`;
            const expectedScssImportPath = `./${baseName}.scss`;
            let customElementImportInfo;
            ts.forEachChild(sourceFile, node => {
                if (ts.isImportDeclaration(node)) {
                    const moduleSpecifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
                    const importClause = node.importClause;
                    // Check for template import (e.g., import template from './...html')
                    if (moduleSpecifier === expectedTemplateImportPath && importClause && importClause.name) {
                        edits.push(vscode_1.TextEdit.delete(getFullLineRange(document, node.getStart(sourceFile), node.getEnd())));
                    }
                    // Check for style side-effect imports
                    else if ((moduleSpecifier === expectedCssImportPath || moduleSpecifier === expectedScssImportPath) && !importClause) {
                        edits.push(vscode_1.TextEdit.delete(getFullLineRange(document, node.getStart(sourceFile), node.getEnd())));
                    }
                    // Check for customElement import
                    else if (moduleSpecifier === '@aurelia/runtime-html' || moduleSpecifier === 'aurelia') {
                        if (importClause && importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
                            const elements = importClause.namedBindings.elements;
                            const ceSpecifier = elements.find(el => el.name.escapedText === 'customElement');
                            if (ceSpecifier) {
                                // Check if it's the only specifier
                                const isOnly = elements.length === 1;
                                // Prefer runtime-html if found in both
                                if (!customElementImportInfo || moduleSpecifier === '@aurelia/runtime-html') {
                                    customElementImportInfo = { node, isOnlySpecifier: isOnly, specifierNode: ceSpecifier };
                                }
                            }
                        }
                    }
                }
            });
            customElementImportInfo ?? (customElementImportInfo = null);
            // --- 3. Add Edit for customElement Import --- 
            if (customElementImportInfo) {
                const checkedImportInfo = customElementImportInfo;
                if (checkedImportInfo.isOnlySpecifier) {
                    // Remove the whole import line
                    edits.push(vscode_1.TextEdit.delete(getFullLineRange(document, checkedImportInfo.node.getStart(sourceFile), checkedImportInfo.node.getEnd())));
                }
                else if (checkedImportInfo.specifierNode) {
                    // Remove just the specifier (including comma if needed)
                    const specifierNode = checkedImportInfo.specifierNode;
                    let specifierStart = specifierNode.getStart(sourceFile);
                    let specifierEnd = specifierNode.getEnd();
                    const namedBindings = checkedImportInfo.node.importClause?.namedBindings; // Should be NamedImports if specifierNode exists
                    const elements = namedBindings.elements;
                    const specifierIndex = elements.findIndex(el => el === specifierNode);
                    // Check for preceding comma and whitespace
                    if (specifierIndex > 0) {
                        const previousSpecifierEnd = elements[specifierIndex - 1].getEnd();
                        const textBetween = fileContent.substring(previousSpecifierEnd, specifierStart);
                        if (textBetween.includes(',')) {
                            specifierStart = previousSpecifierEnd + textBetween.indexOf(',');
                        }
                    }
                    // Check for trailing comma and whitespace (if not the last element)
                    else if (elements.length > 1) {
                        const nextSpecifierStart = elements[specifierIndex + 1].getStart(sourceFile);
                        const textBetween = fileContent.substring(specifierEnd, nextSpecifierStart);
                        if (textBetween.includes(',')) {
                            specifierEnd = specifierEnd + textBetween.indexOf(',') + 1;
                            const textAfterComma = fileContent.substring(specifierEnd);
                            const closingBraceMatch = textAfterComma.match(/^\s*\}/);
                            if (closingBraceMatch) {
                                specifierEnd += closingBraceMatch[0].length - 1;
                            }
                        }
                    }
                    edits.push(vscode_1.TextEdit.delete(new vscode_1.Range(document.positionAt(specifierStart), document.positionAt(specifierEnd))));
                }
            }
            // --- 4. Apply all collected edits --- 
            if (edits.length > 0) {
                // Sort edits descending by start position to prevent range conflicts
                edits.sort((a, b) => b.range.start.compareTo(a.range.start));
                const finalEdit = new vscode_1.WorkspaceEdit();
                finalEdit.set(document.uri, edits);
                const success = await vscode_1.workspace.applyEdit(finalEdit);
                if (!success) {
                    vscode_1.window.showErrorMessage('Failed to apply edits to make element implicit.');
                }
            }
        }
        catch (error) {
            vscode_1.window.showErrorMessage(error.message || 'Failed to make element implicit.');
        }
    });
    context.subscriptions.push(makeExplicitCommand, makeImplicitCommand);
    // --- Folder Commands ---
    const makeFolderExplicit = vscode_1.commands.registerCommand('aurelia.makeFolderExplicit', async (folderUri) => {
        console.log(`>>> Entering aurelia.makeFolderExplicit command for URI: ${folderUri?.fsPath ?? 'undefined'}`);
        try {
            if (!folderUri) {
                vscode_1.window.showErrorMessage('No folder selected.');
                return;
            }
            await vscode_1.window.withProgress({
                location: vscode_1.ProgressLocation.Notification,
                title: `Aurelia: Making elements explicit in ${path.basename(folderUri.fsPath)}...`,
                cancellable: true
            }, async (progress, token) => {
                const allEdits = new vscode_1.WorkspaceEdit();
                const pattern = new vscode_1.RelativePattern(folderUri, '**/*.ts');
                const tsFiles = await vscode_1.workspace.findFiles(pattern);
                let processedCount = 0;
                progress.report({ message: `Found ${tsFiles.length} TS files. Checking pairs...`, increment: 0 });
                for (const fileUri of tsFiles) {
                    if (token.isCancellationRequested)
                        break;
                    const currentDir = path.dirname(fileUri.fsPath);
                    const baseName = path.basename(fileUri.fsPath, '.ts');
                    const potentialHtmlPath = path.join(currentDir, `${baseName}.html`);
                    progress.report({ message: `Checking ${baseName}.ts...`, increment: (1 / tsFiles.length) * 50 }); // Progress for check
                    let fileHasPair = false;
                    try {
                        const htmlPair = await vscode_1.workspace.findFiles(vscode_1.workspace.asRelativePath(potentialHtmlPath), null, 1);
                        fileHasPair = htmlPair.length > 0;
                    }
                    catch (e) {
                        console.error(`Error checking pair for ${fileUri.fsPath}`, e);
                    }
                    if (fileHasPair) {
                        try {
                            const fileContent = await vscode_1.workspace.fs.readFile(fileUri);
                            const sourceFile = ts.createSourceFile(fileUri.fsPath, fileContent.toString(), ts.ScriptTarget.Latest, true);
                            const classNode = findExportedClassNode(sourceFile); // Might throw
                            const decorator = findCustomElementDecorator(classNode);
                            if (!decorator) { // Only process if decorator is missing
                                const documentToEdit = await vscode_1.workspace.openTextDocument(fileUri);
                                const importInfo = checkCustomElementImportStatus(sourceFile);
                                const className = classNode.name?.getText(sourceFile);
                                if (!className)
                                    throw new Error(`Could not get class name for ${fileUri.fsPath}`);
                                // --- Find paired files (again, for paths) --- 
                                let templateImportPath;
                                const styleImportPaths = [];
                                const potentialCssPath = path.join(currentDir, `${baseName}.css`);
                                const potentialScssPath = path.join(currentDir, `${baseName}.scss`);
                                if (fs.existsSync(potentialHtmlPath))
                                    templateImportPath = `./${baseName}.html`;
                                if (fs.existsSync(potentialCssPath))
                                    styleImportPaths.push(`./${baseName}.css`);
                                if (fs.existsSync(potentialScssPath))
                                    styleImportPaths.push(`./${baseName}.scss`);
                                // Build decorator
                                const kebabName = toKebabCase(className);
                                const decoratorArgParts = [`name: '${kebabName}'`, `template`];
                                const decoratorArg = `{ ${decoratorArgParts.join(', ')} }`;
                                const decoratorText = `@customElement(${decoratorArg})\n`;
                                const classPosition = documentToEdit.positionAt(classNode.getStart(sourceFile)); // Use document from where? Need TextDocument!
                                // --> Issue: Need TextDocument to get positionAt.
                                // --> Solution: Apply edits directly using offsets? Or open docs (slow)?
                                // --> Let's try using offsets and TextEdit directly for WorkspaceEdit.
                                const fileEdits = [];
                                // Handle Imports
                                if (importInfo.needsNewImport) {
                                    const importText = `import { customElement } from '@aurelia/runtime-html';\n`;
                                    fileEdits.push(vscode_1.TextEdit.insert(new vscode_1.Position(0, 0), importText));
                                }
                                else if (importInfo.needsToAddSpecifier && importInfo.existingImportNode) {
                                    const importNode = importInfo.existingImportNode;
                                    const clause = importNode.importClause;
                                    if (clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                                        const existingSpecifiers = clause.namedBindings.elements;
                                        const newSpecifierText = 'customElement';
                                        let insertPosOffset;
                                        if (existingSpecifiers.length > 0) {
                                            insertPosOffset = existingSpecifiers[existingSpecifiers.length - 1].getEnd();
                                        }
                                        else {
                                            insertPosOffset = clause.namedBindings.getStart() + 1;
                                            const braceText = clause.namedBindings.getText(sourceFile);
                                            if (braceText.length > 2 && /^\{\s*\}\s*$/.test(braceText)) {
                                                insertPosOffset = clause.namedBindings.getEnd() - 1;
                                            }
                                        }
                                        const textToInsert = existingSpecifiers.length > 0 ? `, ${newSpecifierText}` : newSpecifierText;
                                        // Need TextDocument for positionAt! Let's apply this separately? No, use offset.
                                        const specifierInsertPosition = documentToEdit.positionAt(insertPosOffset); // Fails!
                                        fileEdits.push(vscode_1.TextEdit.insert(specifierInsertPosition, textToInsert));
                                        // ---> Major Problem: Cannot get Position without TextDocument
                                        // ---> Refactor needed: Process files individually, opening them? Or use offset-based edits? 
                                        // ---> Let's stick to the plan of ONE WorkspaceEdit but simplify edits for now.
                                        // ---> We will INSERT imports at top (0,0) and decorator before class start offset.
                                        // ---> Adding specifier to existing import is too complex without opening doc.
                                        // ---> Simplified Approach for Folder Operation: 
                                        // ---> Always add a NEW import line for customElement if needed.
                                        // ---> Always add NEW import lines for template/styles.
                                        // ---> This might create duplicates, but is safer for bulk operation.
                                    }
                                }
                                // Add template/style imports (Simplified: always add)
                                let newImportsText = '';
                                if (importInfo.needsNewImport) {
                                    newImportsText += `import { customElement } from '@aurelia/runtime-html';\n`;
                                }
                                if (templateImportPath) {
                                    newImportsText += `import template from '${templateImportPath}';\n`;
                                }
                                styleImportPaths.forEach((stylePath) => {
                                    newImportsText += `import '${stylePath}';\n`;
                                });
                                if (newImportsText) {
                                    fileEdits.push(vscode_1.TextEdit.insert(new vscode_1.Position(0, 0), newImportsText)); // Insert all at top
                                }
                                // Add decorator
                                const classStartOffset = classNode.getStart(sourceFile);
                                fileEdits.push(vscode_1.TextEdit.insert(documentToEdit.positionAt(classStartOffset), decoratorText));
                                // ===>> Conclusion: Must open each document to apply edits reliably <<=== 
                                // This makes the bulk operation much slower. Let's proceed with this understanding.
                            }
                        }
                        catch (e) {
                            console.error(`Error processing ${fileUri.fsPath}: ${e.message}`);
                            // Optionally report progress error?
                        }
                    }
                    processedCount++;
                    progress.report({ message: `Processed ${processedCount}/${tsFiles.length} files...`, increment: (1 / tsFiles.length) * 50 }); // Progress for process
                }
                // ===> REFACTOR: Apply Edits by Opening Documents <=== 
                progress.report({ message: `Applying changes...`, increment: 100 });
                let appliedCount = 0;
                let errorCount = 0;
                // --- Refactored Apply Logic --- 
                const changesMap = new Map(); // uri -> edits
                // --- Re-iterate to build changesMap (cannot build directly above) --- 
                for (const fileUri of tsFiles) {
                    if (token.isCancellationRequested)
                        break;
                    const currentDir = path.dirname(fileUri.fsPath);
                    const baseName = path.basename(fileUri.fsPath, '.ts');
                    const potentialHtmlPath = path.join(currentDir, `${baseName}.html`);
                    let fileHasPair = fs.existsSync(potentialHtmlPath); // Use sync fs check here?
                    if (fileHasPair) {
                        try {
                            const documentToEdit = await vscode_1.workspace.openTextDocument(fileUri);
                            const fileContent = documentToEdit.getText();
                            const sourceFile = ts.createSourceFile(fileUri.fsPath, fileContent, ts.ScriptTarget.Latest, true);
                            const classNode = findExportedClassNode(sourceFile);
                            const decorator = findCustomElementDecorator(classNode);
                            if (!decorator) { // Only collect edits if decorator is missing
                                const fileEdits = [];
                                const importInfo = checkCustomElementImportStatus(sourceFile);
                                const className = classNode.name?.getText(sourceFile);
                                if (!className)
                                    continue; // Skip if no class name
                                const templateImportPath = `./${baseName}.html`; // Assume exists from above check
                                const stylesPaths = [];
                                const potentialCssPath = path.join(currentDir, `${baseName}.css`);
                                const potentialScssPath = path.join(currentDir, `${baseName}.scss`);
                                if (fs.existsSync(potentialCssPath))
                                    stylesPaths.push(`./${baseName}.css`);
                                if (fs.existsSync(potentialScssPath))
                                    stylesPaths.push(`./${baseName}.scss`);
                                const kebabName = toKebabCase(className);
                                const decoratorArgParts = [`name: '${kebabName}'`, `template`];
                                const decoratorArg = `{ ${decoratorArgParts.join(', ')} }`;
                                const decoratorText = `@customElement(${decoratorArg})\n`;
                                // Build Imports Text
                                let newImportsText = '';
                                if (importInfo.needsNewImport) {
                                    newImportsText += `import { customElement } from '@aurelia/runtime-html';\n`;
                                }
                                newImportsText += `import template from '${templateImportPath}';\n`;
                                stylesPaths.forEach((stylePath) => {
                                    newImportsText += `import '${stylePath}';\n`;
                                });
                                // Find position after last import or at top
                                let lastImportEndOffset = 0;
                                ts.forEachChild(sourceFile, node => {
                                    if (ts.isImportDeclaration(node)) {
                                        lastImportEndOffset = node.getEnd();
                                    }
                                });
                                const importInsertPosition = lastImportEndOffset > 0 ?
                                    documentToEdit.positionAt(lastImportEndOffset) : // Fails!
                                    new vscode_1.Position(0, 0);
                                // Need TextDocument! Let's apply edits individually per file.
                                // ===>> Refined Plan: Process and save file by file <<=== 
                                changesMap.set(fileUri.toString(), fileEdits); // Store edits per URI
                                // Actual edit generation needs TextDocument below
                            }
                        }
                        catch (e) { /* ignore errors during collection */ }
                    }
                }
                // --- End Re-iteration --- 
                // --- Process Each File with Edits --- 
                progress.report({ message: `Preparing ${changesMap.size} files for update...` });
                const urisToModify = Array.from(changesMap.keys());
                for (let i = 0; i < urisToModify.length; i++) {
                    const uriString = urisToModify[i];
                    const fileUri = vscode_1.Uri.parse(uriString);
                    if (token.isCancellationRequested)
                        break;
                    progress.report({ message: `Updating ${i + 1}/${urisToModify.length}: ${path.basename(fileUri.fsPath)}...` });
                    try {
                        const documentToEdit = await vscode_1.workspace.openTextDocument(fileUri);
                        const fileContent = documentToEdit.getText(); // Get current content
                        const sourceFile = ts.createSourceFile(fileUri.fsPath, fileContent, ts.ScriptTarget.Latest, true);
                        const classNode = findExportedClassNode(sourceFile);
                        const importInfo = checkCustomElementImportStatus(sourceFile);
                        const className = classNode.name?.getText(sourceFile);
                        if (!className)
                            continue;
                        const baseName = path.basename(fileUri.fsPath, '.ts');
                        const currentDir = path.dirname(fileUri.fsPath);
                        const templateImportPath = `./${baseName}.html`;
                        const stylesPaths = [];
                        const potentialCssPath = path.join(currentDir, `${baseName}.css`);
                        const potentialScssPath = path.join(currentDir, `${baseName}.scss`);
                        if (fs.existsSync(potentialCssPath))
                            stylesPaths.push(`./${baseName}.css`);
                        if (fs.existsSync(potentialScssPath))
                            stylesPaths.push(`./${baseName}.scss`);
                        const kebabName = toKebabCase(className);
                        const decoratorArgParts = [`name: '${kebabName}'`, `template`];
                        const decoratorArg = `{ ${decoratorArgParts.join(', ')} }`;
                        const decoratorText = `@customElement(${decoratorArg})\n`;
                        const fileEdits = [];
                        // Build Imports Text & find insert position
                        let newImportsText = '';
                        if (importInfo.needsNewImport) {
                            newImportsText += `import { customElement } from '@aurelia/runtime-html';\n`;
                        }
                        newImportsText += `import template from '${templateImportPath}';\n`;
                        stylesPaths.forEach((stylePath) => {
                            newImportsText += `import '${stylePath}';\n`;
                        });
                        let lastImportEndOffset = 0;
                        ts.forEachChild(sourceFile, node => {
                            if (ts.isImportDeclaration(node)) {
                                lastImportEndOffset = node.getEnd();
                            }
                        });
                        let importsInsertPosition = new vscode_1.Position(0, 0);
                        let lineEnding = '\n'; // Default
                        if (lastImportEndOffset > 0) {
                            const pos = documentToEdit.positionAt(lastImportEndOffset);
                            importsInsertPosition = new vscode_1.Position(pos.line + 1, 0); // Insert on line below last import
                            if (documentToEdit.lineCount > pos.line + 1 && documentToEdit.lineAt(pos.line + 1).text.trim() !== '') {
                                lineEnding = documentToEdit.eol === vscode_1.EndOfLine.CRLF ? '\r\n\r\n' : '\n\n';
                            }
                            else {
                                lineEnding = documentToEdit.eol === vscode_1.EndOfLine.CRLF ? '\r\n' : '\n';
                            }
                        }
                        else {
                            lineEnding = documentToEdit.eol === vscode_1.EndOfLine.CRLF ? '\r\n' : '\n';
                            if (documentToEdit.lineCount > 0 && documentToEdit.lineAt(0).text.trim() !== '') {
                                lineEnding += lineEnding;
                            }
                        }
                        if (newImportsText) {
                            fileEdits.push(vscode_1.TextEdit.insert(importsInsertPosition, newImportsText + lineEnding));
                        }
                        // Add decorator
                        const classStartOffset = classNode.getStart(sourceFile);
                        fileEdits.push(vscode_1.TextEdit.insert(documentToEdit.positionAt(classStartOffset), decoratorText));
                        // Apply edits to this file
                        if (fileEdits.length > 0) {
                            const fileWorkspaceEdit = new vscode_1.WorkspaceEdit();
                            fileEdits.sort((a, b) => b.range.start.compareTo(a.range.start));
                            fileWorkspaceEdit.set(fileUri, fileEdits);
                            const success = await vscode_1.workspace.applyEdit(fileWorkspaceEdit);
                            if (success) {
                                await documentToEdit.save(); // Save after successful edit
                                appliedCount++;
                            }
                            else {
                                errorCount++;
                            }
                        }
                    }
                    catch (e) {
                        console.error(`Error processing/editing ${fileUri.fsPath}: ${e.message}`);
                        errorCount++;
                    }
                }
                // --- End Process Each File --- 
                if (token.isCancellationRequested) {
                    vscode_1.window.showInformationMessage('Operation cancelled.');
                }
                else if (errorCount > 0) {
                    vscode_1.window.showWarningMessage(`Operation completed with ${errorCount} errors. ${appliedCount} files updated.`);
                }
                else {
                    vscode_1.window.showInformationMessage(`Operation complete. ${appliedCount} files updated.`);
                }
            });
        }
        catch (error) {
            console.error('[FolderExplicit Command Error]', error);
            vscode_1.window.showErrorMessage(`Error making elements explicit: ${error.message || 'Unknown error'}`);
        }
    });
    const makeFolderImplicit = vscode_1.commands.registerCommand('aurelia.makeFolderImplicit', async (folderUri) => {
        console.log(`>>> Entering aurelia.makeFolderImplicit command for URI: ${folderUri?.fsPath ?? 'undefined'}`);
        try {
            if (!folderUri) {
                vscode_1.window.showErrorMessage('No folder selected.');
                return;
            }
            // Similar structure: use withProgress, findFiles, iterate, openTextDocument, collect edits, applyEdit+save
            // Remember to remove template/style imports as well.
            await vscode_1.window.withProgress({
                location: vscode_1.ProgressLocation.Notification,
                title: `Aurelia: Making elements implicit in ${path.basename(folderUri.fsPath)}...`,
                cancellable: true
            }, async (progress, token) => {
                const pattern = new vscode_1.RelativePattern(folderUri, '**/*.ts');
                const tsFiles = await vscode_1.workspace.findFiles(pattern);
                let appliedCount = 0;
                let errorCount = 0;
                progress.report({ message: `Found ${tsFiles.length} TS files. Processing...`, increment: 0 });
                for (let i = 0; i < tsFiles.length; i++) {
                    const fileUri = tsFiles[i];
                    if (token.isCancellationRequested)
                        break;
                    progress.report({ message: `Processing ${i + 1}/${tsFiles.length}: ${path.basename(fileUri.fsPath)}...` });
                    try {
                        const documentToEdit = await vscode_1.workspace.openTextDocument(fileUri);
                        const fileContent = documentToEdit.getText();
                        const sourceFile = ts.createSourceFile(fileUri.fsPath, fileContent, ts.ScriptTarget.Latest, true);
                        const baseName = path.basename(fileUri.fsPath, '.ts');
                        let classNode;
                        try {
                            classNode = findExportedClassNode(sourceFile);
                        }
                        catch {
                            continue;
                        } // Skip if no exported class
                        const decoratorToRemove = findCustomElementDecorator(classNode);
                        if (decoratorToRemove) {
                            const fileEdits = [];
                            // Remove Decorator
                            const decoratorStart = decoratorToRemove.getStart(sourceFile);
                            const decoratorEnd = decoratorToRemove.getEnd();
                            let startPos = decoratorStart;
                            const textBeforeDecorator = fileContent.substring(0, decoratorStart);
                            const lastNewlineBeforeDecorator = textBeforeDecorator.lastIndexOf('\n');
                            if (lastNewlineBeforeDecorator !== -1) {
                                const whitespaceBetween = textBeforeDecorator.substring(lastNewlineBeforeDecorator + 1);
                                if (/^\s*$/.test(whitespaceBetween)) {
                                    startPos = lastNewlineBeforeDecorator + 1;
                                }
                            }
                            const rangeToRemoveDecorator = new vscode_1.Range(documentToEdit.positionAt(startPos), documentToEdit.positionAt(decoratorEnd));
                            fileEdits.push(vscode_1.TextEdit.delete(rangeToRemoveDecorator));
                            // Find and Remove Associated Imports
                            const expectedTemplateImportPath = `./${baseName}.html`;
                            const expectedCssImportPath = `./${baseName}.css`;
                            const expectedScssImportPath = `./${baseName}.scss`;
                            let customElementImportInfo;
                            ts.forEachChild(sourceFile, node => {
                                if (ts.isImportDeclaration(node)) {
                                    const moduleSpecifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
                                    const importClause = node.importClause;
                                    if (moduleSpecifier === expectedTemplateImportPath && importClause && importClause.name) {
                                        fileEdits.push(vscode_1.TextEdit.delete(getFullLineRange(documentToEdit, node.getStart(sourceFile), node.getEnd())));
                                    }
                                    else if ((moduleSpecifier === expectedCssImportPath || moduleSpecifier === expectedScssImportPath) && !importClause) {
                                        fileEdits.push(vscode_1.TextEdit.delete(getFullLineRange(documentToEdit, node.getStart(sourceFile), node.getEnd())));
                                    }
                                    else if (moduleSpecifier === '@aurelia/runtime-html' || moduleSpecifier === 'aurelia') {
                                        if (importClause && importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
                                            const elements = importClause.namedBindings.elements;
                                            const ceSpecifier = elements.find(el => el.name.escapedText === 'customElement');
                                            if (ceSpecifier) {
                                                const isOnly = elements.length === 1;
                                                if (!customElementImportInfo || moduleSpecifier === '@aurelia/runtime-html') {
                                                    customElementImportInfo = { node, isOnlySpecifier: isOnly, specifierNode: ceSpecifier };
                                                }
                                            }
                                        }
                                    }
                                }
                            });
                            customElementImportInfo ?? (customElementImportInfo = null);
                            // Add Edit for customElement Import Removal
                            if (customElementImportInfo) {
                                const checkedImportInfo = customElementImportInfo;
                                if (checkedImportInfo.isOnlySpecifier) {
                                    fileEdits.push(vscode_1.TextEdit.delete(getFullLineRange(documentToEdit, checkedImportInfo.node.getStart(sourceFile), checkedImportInfo.node.getEnd())));
                                }
                                else if (checkedImportInfo.specifierNode) {
                                    const specifierNode = checkedImportInfo.specifierNode;
                                    let specifierStart = specifierNode.getStart(sourceFile);
                                    let specifierEnd = specifierNode.getEnd();
                                    const namedBindings = checkedImportInfo.node.importClause?.namedBindings;
                                    const elements = namedBindings.elements;
                                    const specifierIndex = elements.findIndex(el => el === specifierNode);
                                    if (specifierIndex > 0) {
                                        const previousSpecifierEnd = elements[specifierIndex - 1].getEnd();
                                        const textBetween = fileContent.substring(previousSpecifierEnd, specifierStart);
                                        if (textBetween.includes(',')) {
                                            specifierStart = previousSpecifierEnd + textBetween.indexOf(',');
                                        }
                                    }
                                    else if (elements.length > 1) {
                                        const nextSpecifierStart = elements[specifierIndex + 1].getStart(sourceFile);
                                        const textBetween = fileContent.substring(specifierEnd, nextSpecifierStart);
                                        if (textBetween.includes(',')) {
                                            specifierEnd = specifierEnd + textBetween.indexOf(',') + 1;
                                            const textAfterComma = fileContent.substring(specifierEnd);
                                            const closingBraceMatch = textAfterComma.match(/^\s*\}/);
                                            if (closingBraceMatch) {
                                                specifierEnd += closingBraceMatch[0].length - 1;
                                            }
                                        }
                                    }
                                    fileEdits.push(vscode_1.TextEdit.delete(new vscode_1.Range(documentToEdit.positionAt(specifierStart), documentToEdit.positionAt(specifierEnd))));
                                }
                            }
                            // Apply edits for this file
                            if (fileEdits.length > 0) {
                                const fileWorkspaceEdit = new vscode_1.WorkspaceEdit();
                                fileEdits.sort((a, b) => b.range.start.compareTo(a.range.start));
                                fileWorkspaceEdit.set(fileUri, fileEdits);
                                const success = await vscode_1.workspace.applyEdit(fileWorkspaceEdit);
                                if (success) {
                                    await documentToEdit.save();
                                    appliedCount++;
                                }
                                else {
                                    errorCount++;
                                }
                            }
                        }
                    }
                    catch (e) {
                        console.error(`Error processing/editing ${fileUri.fsPath}: ${e.message}`);
                        errorCount++;
                    }
                }
                // --- End Loop --- 
                if (token.isCancellationRequested) {
                    vscode_1.window.showInformationMessage('Operation cancelled.');
                }
                else if (errorCount > 0) {
                    vscode_1.window.showWarningMessage(`Operation completed with ${errorCount} errors. ${appliedCount} files updated.`);
                }
                else {
                    vscode_1.window.showInformationMessage(`Operation complete. ${appliedCount} files updated.`);
                }
            });
        }
        catch (error) {
            console.error('[FolderImplicit Command Error]', error);
            vscode_1.window.showErrorMessage(`Error making elements implicit: ${error.message || 'Unknown error'}`);
        }
    });
    context.subscriptions.push(makeFolderExplicit, makeFolderImplicit);
}
// --- Helper Functions ---
// Find the exported class declaration node
function findExportedClassNode(sourceFile) {
    let classNode;
    ts.forEachChild(sourceFile, node => {
        if (ts.isClassDeclaration(node) && ts.canHaveModifiers(node)) {
            const modifiers = ts.getModifiers(node);
            if (modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
                classNode = node;
            }
        }
        if (classNode)
            return; // Stop searching once found
    });
    if (!classNode) {
        throw new Error('Could not find exported class declaration.');
    }
    return classNode;
}
// Find the @customElement decorator on a given class node
function findCustomElementDecorator(classNode) {
    const decorators = ts.getDecorators(classNode);
    if (decorators) {
        for (const decorator of decorators) {
            if (ts.isCallExpression(decorator.expression) &&
                ts.isIdentifier(decorator.expression.expression) &&
                decorator.expression.expression.escapedText === 'customElement') {
                return decorator;
            }
        }
    }
    return undefined;
}
// Check if customElement is imported from @aurelia/runtime-html
function checkNeedsCustomElementImport(sourceFile) {
    let needsImport = true;
    ts.forEachChild(sourceFile, node => {
        if (ts.isImportDeclaration(node) &&
            node.moduleSpecifier.getText(sourceFile).includes('@aurelia/runtime-html')) {
            const namedBindings = node.importClause?.namedBindings;
            if (namedBindings && ts.isNamedImports(namedBindings)) {
                if (namedBindings.elements.some(el => el.name.escapedText === 'customElement')) {
                    needsImport = false;
                }
            }
        }
        if (!needsImport)
            return; // Stop searching
    });
    return needsImport;
}
// <<< New function to check import status more thoroughly >>>
function checkCustomElementImportStatus(sourceFile) {
    let needsNewImport = true;
    let specifierFound = false;
    let nodeToModify = null;
    let moduleToModify = null;
    ts.forEachChild(sourceFile, node => {
        if (!ts.isImportDeclaration(node))
            return;
        const moduleName = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
        if (moduleName === '@aurelia/runtime-html' || moduleName === 'aurelia') {
            needsNewImport = false; // Found a relevant import
            const namedBindings = node.importClause?.namedBindings;
            if (namedBindings && ts.isNamedImports(namedBindings)) {
                const hasSpecifier = namedBindings.elements.some(el => el.name.escapedText === 'customElement');
                if (hasSpecifier) {
                    specifierFound = true;
                    // Prefer runtime-html if specifier is found there
                    if (moduleName === '@aurelia/runtime-html') {
                        nodeToModify = node;
                        moduleToModify = moduleName;
                        return; // Stop searching, preference met
                    }
                    else if (!nodeToModify) { // If not already set by runtime-html
                        nodeToModify = node;
                        moduleToModify = moduleName;
                    }
                }
                else {
                    // Specifier not found in this import, but it's a potential candidate for modification
                    // Prefer runtime-html if available
                    if (moduleName === '@aurelia/runtime-html') {
                        nodeToModify = node;
                        moduleToModify = moduleName;
                    }
                    else if (!nodeToModify) { // Only set if runtime-html wasn't found
                        nodeToModify = node;
                        moduleToModify = moduleName;
                    }
                }
            }
            else if (!nodeToModify) {
                // Import exists, but is not NamedImports (e.g., import * as X) 
                // or has no bindings. Mark it as potential node if none better found.
                nodeToModify = node;
                moduleToModify = moduleName;
            }
        }
    });
    return {
        needsNewImport,
        specifierFound,
        needsToAddSpecifier: !needsNewImport && !specifierFound && !!nodeToModify, // Can only add if we found a place
        existingImportNode: nodeToModify,
        existingModuleName: moduleToModify
    };
}
// Helper to get the full line range for deleting imports
function getFullLineRange(document, startOffset, endOffset) {
    const startPosition = document.positionAt(startOffset);
    const endPosition = document.positionAt(endOffset);
    // Expand start to beginning of the line
    const lineStart = new vscode_1.Position(startPosition.line, 0);
    // Expand end to end of the line (including newline)
    let lineEnd;
    if (endPosition.line + 1 < document.lineCount) {
        lineEnd = new vscode_1.Position(endPosition.line + 1, 0);
    }
    else {
        lineEnd = document.lineAt(endPosition.line).range.end;
    }
    return new vscode_1.Range(lineStart, lineEnd);
}
function deactivate() {
    if (!client) {
        return undefined;
    }
    console.log('Deactivating Aurelia Language Client.');
    return client.stop();
}
//# sourceMappingURL=extension.js.map