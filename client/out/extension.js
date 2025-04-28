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
}
function deactivate() {
    if (!client) {
        return undefined;
    }
    console.log('Deactivating Aurelia Language Client.');
    return client.stop();
}
//# sourceMappingURL=extension.js.map