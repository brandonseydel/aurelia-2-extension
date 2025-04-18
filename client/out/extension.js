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
        }
    };
    // Create the language client and start the client.
    client = new node_1.LanguageClient('aureliaLanguageServer', 'Aurelia Language Server', serverOptions, clientOptions);
    // Start the client. This will also launch the server
    client.start();
    console.log('Aurelia Language Client activated.');
}
function deactivate() {
    if (!client) {
        return undefined;
    }
    console.log('Deactivating Aurelia Language Client.');
    return client.stop();
}
//# sourceMappingURL=extension.js.map