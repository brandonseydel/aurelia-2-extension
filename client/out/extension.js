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
const node_1 = require("vscode-languageclient/node");
let client;
// Helper function to convert kebab-case to PascalCase
function kebabToPascalCase(str) {
    return str
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}
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
        console.log('info', '[Context] Checking if workspace is an Aurelia project...');
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
                            console.log('info', '[Context] Aurelia project detected (found @aurelia dependency).');
                            break;
                        }
                    }
                }
                else {
                    console.log('warn', '[Context] Root package.json not found.');
                }
            }
            catch (error) {
                console.error('[Context] Error reading or parsing root package.json:', error);
            }
        }
        if (!isAureliaProject) {
            console.log('info', '[Context] Not detected as an Aurelia project.');
        }
        await vscode_1.commands.executeCommand('setContext', 'aurelia:isAureliaProject', isAureliaProject);
        return isAureliaProject;
    }
    async function updateContextKeys(editor = vscode_1.window.activeTextEditor) {
        const isProject = await checkIsAureliaProject();
        let hasPairedHtml = false;
        let hasPairedTs = false;
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
                }
                catch { /* Ignore errors */ }
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
        console.log('debug', `[Context] Updating keys: isProject=${isProject}, hasPairedHtml=${hasPairedHtml}, hasPairedTs=${hasPairedTs}`);
        await vscode_1.commands.executeCommand('setContext', 'aurelia:hasPairedHtml', hasPairedHtml);
        await vscode_1.commands.executeCommand('setContext', 'aurelia:hasPairedTs', hasPairedTs);
        // isAureliaProject context is set within checkIsAureliaProject itself
    }
    // Initial checks
    checkIsAureliaProject().then(() => {
        updateContextKeys(vscode_1.window.activeTextEditor);
    });
    // Watch for active editor changes
    context.subscriptions.push(vscode_1.window.onDidChangeActiveTextEditor(editor => {
        console.log('debug', '[Context] Active editor changed.');
        updateContextKeys(editor);
    }));
    // Watch root package.json for changes
    if (vscode_1.workspace.workspaceFolders && vscode_1.workspace.workspaceFolders.length > 0) {
        const rootPath = vscode_1.workspace.workspaceFolders[0].uri.fsPath;
        const pattern = new vscode_1.RelativePattern(vscode_1.workspace.workspaceFolders[0], 'package.json');
        rootPackageJsonWatcher = vscode_1.workspace.createFileSystemWatcher(pattern);
        rootPackageJsonWatcher.onDidChange(() => {
            console.log('info', '[Context] Root package.json changed. Re-evaluating project status.');
            isAureliaProject = undefined; // Clear cache
            checkIsAureliaProject().then(() => {
                updateContextKeys(vscode_1.window.activeTextEditor);
            });
        });
        rootPackageJsonWatcher.onDidCreate(() => { });
        rootPackageJsonWatcher.onDidDelete(() => { });
        context.subscriptions.push(rootPackageJsonWatcher);
    }
    // Watch for TS/HTML file creation/deletion to update paired status
    pairedFileWatcher = vscode_1.workspace.createFileSystemWatcher('**/*.{ts,html}');
    const pairedFileChangeHandler = (uri) => {
        console.log('debug', `[Context] Paired file watcher triggered for: ${uri.fsPath}`);
        const activeEditor = vscode_1.window.activeTextEditor;
        // Only update if the changed file could be the pair of the currently active file
        if (activeEditor) {
            const activePath = activeEditor.document.uri.fsPath;
            const activeDir = path.dirname(activePath);
            const activeBaseName = path.basename(activePath, path.extname(activePath));
            const changedPath = uri.fsPath;
            const changedDir = path.dirname(changedPath);
            const changedBaseName = path.basename(changedPath, path.extname(changedPath));
            if (activeDir === changedDir && activeBaseName === changedBaseName) {
                console.log('info', '[Context] Change detected affects potential pair of active file. Updating context keys.');
                updateContextKeys(activeEditor); // Re-run checks for the current editor
            }
        }
    };
    pairedFileWatcher.onDidChange(pairedFileChangeHandler); // Handle existing file changes (less relevant here)
    pairedFileWatcher.onDidCreate(pairedFileChangeHandler);
    pairedFileWatcher.onDidDelete(pairedFileChangeHandler);
    context.subscriptions.push(pairedFileWatcher);
}
function deactivate() {
    if (!client) {
        return undefined;
    }
    console.log('Deactivating Aurelia Language Client.');
    return client.stop();
}
//# sourceMappingURL=extension.js.map