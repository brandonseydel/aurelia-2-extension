import * as path from 'path';
import { workspace, ExtensionContext, SemanticTokensLegend, commands, window, Uri, Position, TextDocument, Range } from 'vscode';

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

// Helper function to convert kebab-case to PascalCase
function kebabToPascalCase(str: string): string {
    return str
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

export function activate(context: ExtensionContext) {
    console.log('--- Activating Aurelia Language Client --- ');

    // Get workspace root path
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: { execArgv: ['--nolazy', '--inspect=6009'] } // Adjust port if needed
        }
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
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
    client = new LanguageClient(
        'aureliaLanguageServer',
        'Aurelia Language Server',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    client.start();
    console.log('Aurelia Language Client activated.');

    // --- Register Go To Commands --- 

    const goToHtmlCommand = commands.registerCommand('aurelia.gotoHtml', async () => {
        const editor = window.activeTextEditor;
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
            const htmlFiles = await workspace.findFiles(workspace.asRelativePath(potentialHtmlPath), null, 1);
            if (htmlFiles.length > 0) {
                const htmlDoc = await workspace.openTextDocument(htmlFiles[0]);
                await window.showTextDocument(htmlDoc);
            } else {
                window.showInformationMessage(`Could not find corresponding HTML file: ${htmlFileName}`);
            }
        } catch (error) {
            console.error("Error finding or opening HTML file:", error);
            window.showErrorMessage('Error navigating to HTML file.');
        }
    });

    const goToCustomElementCommand = commands.registerCommand('aurelia.gotoCustomElement', async () => {
        const editor = window.activeTextEditor;
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
            const tsFiles = await workspace.findFiles(workspace.asRelativePath(potentialTsPath), null, 1);
            
            if (tsFiles.length > 0) {
                const tsDoc = await workspace.openTextDocument(tsFiles[0]);
                await window.showTextDocument(tsDoc);
            } else {
                window.showInformationMessage(`Could not find corresponding definition file: ${tsFileName} in the same directory.`);
            }
        } catch (error) {
            console.error("Error finding or opening Custom Element definition:", error);
            window.showErrorMessage('Error navigating to Custom Element definition.');
        }
    });

    context.subscriptions.push(goToHtmlCommand, goToCustomElementCommand);
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    console.log('Deactivating Aurelia Language Client.');
    return client.stop();
} 