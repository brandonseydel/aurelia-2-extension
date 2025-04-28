import * as path from 'path';
import { workspace, ExtensionContext, SemanticTokensLegend, commands, window, Uri, Position, TextDocument, Range, TextEditor, FileSystemWatcher, RelativePattern } from 'vscode';
import * as fs from 'fs'; // Import fs for reading package.json

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

    // --- Context Key Management --- 

    let isAureliaProject: boolean | undefined = undefined; // Cache the result
    let rootPackageJsonWatcher: FileSystemWatcher | undefined;
    let pairedFileWatcher: FileSystemWatcher | undefined;

    async function checkIsAureliaProject(): Promise<boolean> {
        if (isAureliaProject !== undefined) return isAureliaProject;

        console.log('info', '[Context] Checking if workspace is an Aurelia project...');
        isAureliaProject = false; // Default
        const workspaceFolders = workspace.workspaceFolders;
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
                } else {
                    console.log('warn', '[Context] Root package.json not found.');
                }
            } catch (error) {
                console.error('[Context] Error reading or parsing root package.json:', error);
            }
        }
        if (!isAureliaProject) {
             console.log('info', '[Context] Not detected as an Aurelia project.');
        }
        await commands.executeCommand('setContext', 'aurelia:isAureliaProject', isAureliaProject);
        return isAureliaProject;
    }

    async function updateContextKeys(editor: TextEditor | undefined = window.activeTextEditor) {
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
                    const htmlFiles = await workspace.findFiles(workspace.asRelativePath(potentialHtmlPath), null, 1);
                    hasPairedHtml = htmlFiles.length > 0;
                } catch { /* Ignore errors */ }
            } else if (document.languageId === 'html') {
                const potentialTsPath = path.join(currentDir, `${baseName}.ts`);
                 try {
                    const tsFiles = await workspace.findFiles(workspace.asRelativePath(potentialTsPath), null, 1);
                    hasPairedTs = tsFiles.length > 0;
                } catch { /* Ignore errors */ }
            }
        }
        
        console.log('debug', `[Context] Updating keys: isProject=${isProject}, hasPairedHtml=${hasPairedHtml}, hasPairedTs=${hasPairedTs}`);
        await commands.executeCommand('setContext', 'aurelia:hasPairedHtml', hasPairedHtml);
        await commands.executeCommand('setContext', 'aurelia:hasPairedTs', hasPairedTs);
        // isAureliaProject context is set within checkIsAureliaProject itself
    }

    // Initial checks
    checkIsAureliaProject().then(() => {
        updateContextKeys(window.activeTextEditor);
    });

    // Watch for active editor changes
    context.subscriptions.push(
        window.onDidChangeActiveTextEditor(editor => {
            console.log('debug', '[Context] Active editor changed.');
            updateContextKeys(editor);
        })
    );

    // Watch root package.json for changes
    if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
        const rootPath = workspace.workspaceFolders[0].uri.fsPath;
        const pattern = new RelativePattern(workspace.workspaceFolders[0], 'package.json');
        rootPackageJsonWatcher = workspace.createFileSystemWatcher(pattern);
        rootPackageJsonWatcher.onDidChange(() => {
            console.log('info', '[Context] Root package.json changed. Re-evaluating project status.');
            isAureliaProject = undefined; // Clear cache
            checkIsAureliaProject().then(() => {
                updateContextKeys(window.activeTextEditor);
            });
        });
        rootPackageJsonWatcher.onDidCreate(() => { /* Handle create similarly? */ });
        rootPackageJsonWatcher.onDidDelete(() => { /* Handle delete similarly? */ });
        context.subscriptions.push(rootPackageJsonWatcher);
    }
    
    // Watch for TS/HTML file creation/deletion to update paired status
    pairedFileWatcher = workspace.createFileSystemWatcher('**/*.{ts,html}');
    const pairedFileChangeHandler = (uri: Uri) => {
         console.log('debug', `[Context] Paired file watcher triggered for: ${uri.fsPath}`);
         const activeEditor = window.activeTextEditor;
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

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    console.log('Deactivating Aurelia Language Client.');
    return client.stop();
} 