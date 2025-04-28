import * as path from 'path';
import { workspace, ExtensionContext, SemanticTokensLegend, commands, window, Uri, Position, TextDocument, Range, TextEditor, FileSystemWatcher, RelativePattern, WorkspaceEdit, TextEdit, ProgressLocation, EndOfLine, Progress, CancellationToken } from 'vscode';
import * as fs from 'fs'; // Import fs for reading package.json
import * as ts from 'typescript'; // Import TS for AST parsing

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

// Helper function to convert PascalCase or camelCase to kebab-case
function toKebabCase(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2') // Get all lowercase letters that are near to uppercase ones
        .replace(/[\s_]+/g, '-') // Replace spaces and underscores with a hyphen
        .toLowerCase();
}

// --- Remove Placeholder Logging ---
// const log = { ... };

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

        console.info('[Context] Checking if workspace is an Aurelia project...');
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
                            console.info('[Context] Aurelia project detected (found @aurelia dependency).');
                            break;
                        }
                    }
                } else {
                    console.warn('[Context] Root package.json not found.');
                }
            } catch (error) {
                console.error('[Context] Error reading or parsing root package.json:', error);
            }
        }
        if (!isAureliaProject) {
            console.info('[Context] Not detected as an Aurelia project.');
        }
        await commands.executeCommand('setContext', 'aurelia:isAureliaProject', isAureliaProject);
        return isAureliaProject;
    }

    async function updateContextKeys(editor: TextEditor | undefined = window.activeTextEditor) {
        const isProject = await checkIsAureliaProject();
        let hasPairedHtml = false;
        let hasPairedTs = false;
        let hasExplicitCE = false; 
        let canBeExplicitCE = false; 

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

                    // If it has a paired HTML, check for CE decorator
                    if (hasPairedHtml) {
                        console.log(`[Context Update] Checking for decorator in ${document.fileName}...`);
                        const fileContent = document.getText();
                        const sourceFile = ts.createSourceFile(document.fileName, fileContent, ts.ScriptTarget.Latest, true);
                        let foundDecorator = false;
                        ts.forEachChild(sourceFile, (node: ts.Node) => {
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
                            if (foundDecorator) return;
                        });
                        hasExplicitCE = foundDecorator;
                        canBeExplicitCE = !foundDecorator;
                        console.log(`[Context Update] Decorator found: ${foundDecorator}`);
                    }

                } catch (e) {
                    console.error('[Context] Error checking for paired HTML or CE decorator:', e);
                }
            }
        }

        console.log(`[Context Update] Final keys: isProject=${isProject}, hasPairedHtml=${hasPairedHtml}, hasPairedTs=${hasPairedTs}, hasExplicitCE=${hasExplicitCE}, canBeExplicitCE=${canBeExplicitCE}`);
        await commands.executeCommand('setContext', 'aurelia:hasPairedHtml', hasPairedHtml);
        await commands.executeCommand('setContext', 'aurelia:hasPairedTs', hasPairedTs);
        await commands.executeCommand('setContext', 'aurelia:tsFileHasExplicitCE', hasExplicitCE);
        await commands.executeCommand('setContext', 'aurelia:tsFileCanBeExplicitCE', canBeExplicitCE);
        console.log('[Context Update] setContext calls finished.');
    }

    // Initial checks
    checkIsAureliaProject().then(() => {
        updateContextKeys(window.activeTextEditor);
    });

    // Watch for active editor changes
    context.subscriptions.push(
        window.onDidChangeActiveTextEditor(editor => {
            console.log('[Context] Active editor changed.');
            updateContextKeys(editor);
        })
    );

    // Watch root package.json for changes
    if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
        const rootPath = workspace.workspaceFolders[0].uri.fsPath;
        const pattern = new RelativePattern(workspace.workspaceFolders[0], 'package.json');
        rootPackageJsonWatcher = workspace.createFileSystemWatcher(pattern);
        rootPackageJsonWatcher.onDidChange(() => {
            console.info('[Context] Root package.json changed. Re-evaluating project status.');
            isAureliaProject = undefined; // Clear cache
            checkIsAureliaProject().then(() => {
                updateContextKeys(window.activeTextEditor);
            });
        });
        rootPackageJsonWatcher.onDidCreate(() => { /* Handle create similarly? */ });
        rootPackageJsonWatcher.onDidDelete(() => { /* Handle delete similarly? */ });
        context.subscriptions.push(rootPackageJsonWatcher);
    }

    // Watch for TS/HTML file creation/deletion/change to update paired status and decorator status
    pairedFileWatcher = workspace.createFileSystemWatcher('**/*.{ts,html}');
    const pairedFileChangeHandler = (uri: Uri) => {
        console.log(`[Context] Paired file watcher triggered for: ${uri.fsPath}`);
        const activeEditor = window.activeTextEditor;
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
    let debounceTimer: NodeJS.Timeout | undefined;
    context.subscriptions.push(
        workspace.onDidChangeTextDocument(event => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(() => {
                console.log('[Context Debounce] Timer fired.'); 
                const activeEditor = window.activeTextEditor;
                if (activeEditor && event.document === activeEditor.document && activeEditor.document.languageId === 'typescript') {
                    console.log(`[Context Debounce] Active TS file changed: ${event.document.uri.fsPath}. Triggering update...`);
                    updateContextKeys(activeEditor); 
                } else {
                     console.log('[Context Debounce] Change was not in active TS editor. No update triggered.');
                }
            }, 50); // 500ms debounce
        })
    );

    // --- Register Single File Commands (Refactored) ---
    const makeExplicitCommand = commands.registerCommand('aurelia.makeElementExplicit', async () => {
        const editor = window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'typescript') return;
        const document = editor.document;
        const sourceFile = ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.Latest, true);

        try {
            const classNode = findExportedClassNode(sourceFile);
            const fileEdits = await generateExplicitEdits(document, sourceFile, classNode);

            if (fileEdits.length > 0) {
                fileEdits.sort((a, b) => b.range.start.compareTo(a.range.start)); 
                const edit = new WorkspaceEdit();
                edit.set(document.uri, fileEdits);
                const success = await workspace.applyEdit(edit);
                if (success) {
                   await document.save();
                } else {
                    window.showErrorMessage('Failed to apply edit to make element explicit.');
                }
            } else {
                window.showInformationMessage('Element may already be explicit.'); 
            }
        } catch (error: any) {
            window.showErrorMessage(error.message || 'Failed to make element explicit.');
        }
    });

    const makeImplicitCommand = commands.registerCommand('aurelia.makeElementImplicit', async () => {
        const editor = window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'typescript') return;
        const document = editor.document;
        const fileContent = document.getText(); // Still needed by generateImplicitEdits
        const sourceFile = ts.createSourceFile(document.fileName, fileContent, ts.ScriptTarget.Latest, true);

        try {
            const classNode = findExportedClassNode(sourceFile);
            const decoratorToRemove = findCustomElementDecorator(classNode);

            if (!decoratorToRemove) {
                window.showInformationMessage('@customElement decorator not found.');
                return;
            }
            
            const fileEdits = await generateImplicitEdits(document, sourceFile, classNode, decoratorToRemove);
            
            if (fileEdits.length > 0) {
                 fileEdits.sort((a, b) => b.range.start.compareTo(a.range.start)); 
                 const edit = new WorkspaceEdit();
                 edit.set(document.uri, fileEdits);
                 const success = await workspace.applyEdit(edit);
                 if (success) {
                    await document.save();
                 } else {
                     window.showErrorMessage('Failed to apply edit to make element implicit.');
                 }
            } 
            // else {
                 // If only decorator was removed, generateImplicitEdits might return edits
                 // If no imports needed removing, maybe no message is needed?
            // }
        } catch (error: any) {
             window.showErrorMessage(error.message || 'Failed to make element implicit.');
        }
    });

    context.subscriptions.push(makeExplicitCommand, makeImplicitCommand);

    // --- Folder Commands (Refactored - Use same helpers) ---
    const makeFolderExplicit = commands.registerCommand('aurelia.makeFolderExplicit', async (folderUri: Uri) => {
        console.log(`>>> Entering aurelia.makeFolderExplicit command for URI: ${folderUri?.fsPath ?? 'undefined'}`);
        if (!folderUri) {
            window.showErrorMessage('No folder selected.');
            return;
        }
        try {
            await window.withProgress({
                location: ProgressLocation.Notification,
                title: `Aurelia: Making elements explicit in ${path.basename(folderUri.fsPath)}...`,
                cancellable: true
            }, async (progress, token) => {
                const explicitProcessor: FileProcessor = async (doc, sf, cn) => {
                    return generateExplicitEdits(doc, sf, cn);
                };
                const result = await processFolderViewModelFiles(folderUri, explicitProcessor, progress, token);
                // Report final status
                if (token.isCancellationRequested) {
                     window.showInformationMessage('Operation cancelled.');
                } else if (result.errorCount > 0) {
                     window.showWarningMessage(`Operation completed with ${result.errorCount} errors. ${result.appliedCount} files updated.`);
                } else {
                     window.showInformationMessage(`Operation complete. ${result.appliedCount} files updated.`);
                }
            });
        } catch (error: any) {
             console.error('[FolderExplicit Command Error]', error);
             window.showErrorMessage(`Error making elements explicit: ${error.message || 'Unknown error'}`);
        }
    });

     const makeFolderImplicit = commands.registerCommand('aurelia.makeFolderImplicit', async (folderUri: Uri) => {
        console.log(`>>> Entering aurelia.makeFolderImplicit command for URI: ${folderUri?.fsPath ?? 'undefined'}`);
         if (!folderUri) {
             window.showErrorMessage('No folder selected.');
             return;
         }
         try {
             await window.withProgress({
                location: ProgressLocation.Notification,
                title: `Aurelia: Making elements implicit in ${path.basename(folderUri.fsPath)}...`,
                cancellable: true
            }, async (progress, token) => {
                const implicitProcessor: FileProcessor = async (doc, sf, cn) => {
                    const decorator = findCustomElementDecorator(cn);
                    if (decorator) { 
                        return generateImplicitEdits(doc, sf, cn, decorator);
                    }
                    return []; 
                };
                const result = await processFolderViewModelFiles(folderUri, implicitProcessor, progress, token);
                 // Report final status
                if (token.isCancellationRequested) {
                    window.showInformationMessage('Operation cancelled.');
               } else if (result.errorCount > 0) {
                    window.showWarningMessage(`Operation completed with ${result.errorCount} errors. ${result.appliedCount} files updated.`);
               } else {
                    window.showInformationMessage(`Operation complete. ${result.appliedCount} files updated.`);
               }
            });
        } catch (error: any) {
            console.error('[FolderImplicit Command Error]', error);
            window.showErrorMessage(`Error making elements implicit: ${error.message || 'Unknown error'}`);
        }
     });

    context.subscriptions.push(makeFolderExplicit, makeFolderImplicit);
}

// --- Helper Functions ---

// Find the exported class declaration node
function findExportedClassNode(sourceFile: ts.SourceFile): ts.ClassDeclaration {
    let classNode: ts.ClassDeclaration | undefined;
    ts.forEachChild(sourceFile, node => {
        if (ts.isClassDeclaration(node) && ts.canHaveModifiers(node)) {
            const modifiers = ts.getModifiers(node);
            if (modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
                classNode = node;
            }
        }
        if (classNode) return; // Stop searching once found
    });
    if (!classNode) {
        throw new Error('Could not find exported class declaration.');
    }
    return classNode;
}

// Find the @customElement decorator on a given class node
function findCustomElementDecorator(classNode: ts.ClassDeclaration): ts.Decorator | undefined {
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

// <<< New function to check import status more thoroughly >>>
function checkCustomElementImportStatus(sourceFile: ts.SourceFile): {
    needsNewImport: boolean;
    needsToAddSpecifier: boolean;
    specifierFound: boolean;
    existingImportNode: ts.ImportDeclaration | null;
    existingModuleName: string | null;
} {
    let needsNewImport = true;
    let specifierFound = false;
    let nodeToModify: ts.ImportDeclaration | null = null;
    let moduleToModify: string | null = null;

    ts.forEachChild(sourceFile, node => {
        if (!ts.isImportDeclaration(node)) return;

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
                    } else if (!nodeToModify) { // If not already set by runtime-html
                        nodeToModify = node;
                        moduleToModify = moduleName;
                    }
                } else {
                    // Specifier not found in this import, but it's a potential candidate for modification
                    // Prefer runtime-html if available
                    if (moduleName === '@aurelia/runtime-html') {
                        nodeToModify = node;
                        moduleToModify = moduleName;
                    } else if (!nodeToModify) { // Only set if runtime-html wasn't found
                        nodeToModify = node;
                        moduleToModify = moduleName;
                    }
                }
            } else if (!nodeToModify) {
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

// Helper to get the full line range INCLUDING the following newline for deleting imports
function getFullLineRangeIncludingNewline(document: TextDocument, startOffset: number, endOffset: number): Range {
    const startPosition = document.positionAt(startOffset);
    const endPosition = document.positionAt(endOffset);
    // Start at the beginning of the first line
    const lineStart = new Position(startPosition.line, 0);
    // End at the beginning of the line AFTER the last line containing the node
    let lineEnd: Position;
    if (endPosition.line + 1 < document.lineCount) {
        lineEnd = new Position(endPosition.line + 1, 0); // Go to start of next line
    } else {
        // If it's the last line, just go to the end of that line
        lineEnd = document.lineAt(endPosition.line).range.end; 
    }
    return new Range(lineStart, lineEnd);
}

// --- Edit Generation Helpers ---

async function generateExplicitEdits(
    documentToEdit: TextDocument,
    sourceFile: ts.SourceFile,
    classNode: ts.ClassDeclaration
): Promise<TextEdit[]> {
    const fileEdits: TextEdit[] = [];
    const fileUri = documentToEdit.uri;

    // Check if decorator already exists 
    if (findCustomElementDecorator(classNode)) {
        console.log(`[generateExplicitEdits] Decorator already exists for ${fileUri.fsPath}, skipping.`);
        return [];
    }

    const importInfo = checkCustomElementImportStatus(sourceFile);
    console.log(`[generateExplicitEdits] Import check for ${fileUri.fsPath}: ${JSON.stringify(importInfo)}`);

    const className = classNode.name?.getText(sourceFile);
    if (!className) return []; 

    // Find paired files
    const baseName = path.basename(fileUri.fsPath, '.ts');
    const currentDir = path.dirname(fileUri.fsPath);
    const potentialHtmlPath = path.join(currentDir, `${baseName}.html`);
    const potentialCssPath = path.join(currentDir, `${baseName}.css`);
    const potentialScssPath = path.join(currentDir, `${baseName}.scss`);
    let templateImportPath: string | undefined;
    const stylesPaths: string[] = [];

    if (fs.existsSync(potentialHtmlPath)) {
        templateImportPath = `./${baseName}.html`;
    }
    if (fs.existsSync(potentialCssPath)) {
        stylesPaths.push(`./${baseName}.css`);
    }
    if (fs.existsSync(potentialScssPath)) {
        stylesPaths.push(`./${baseName}.scss`);
    }

    // Build Imports Text
    let importsToAdd: string[] = [];
    if (importInfo.needsNewImport) {
        importsToAdd.push(`import { customElement } from '@aurelia/runtime-html';`);
    } 
    
    if (templateImportPath) {
        importsToAdd.push(`import template from '${templateImportPath}';`);
    }
    stylesPaths.forEach((stylePath) => {
        importsToAdd.push(`import '${stylePath}';`);
    });
    let newImportsText = importsToAdd.join(documentToEdit.eol === EndOfLine.CRLF ? '\r\n' : '\n');

    // Add Import Edits
    if (newImportsText) {
        fileEdits.push(TextEdit.insert(new Position(0, 0), newImportsText));
        console.log(`[generateExplicitEdits] Added block import edit for ${fileUri.fsPath}`);
    }
    
    if (importInfo.needsToAddSpecifier && importInfo.existingImportNode) {
        const importNode = importInfo.existingImportNode;
        const clause = importNode.importClause;
        if (clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            const existingSpecifiers = clause.namedBindings.elements;
            const newSpecifierText = 'customElement';
            let insertPosOffset: number;
             if (existingSpecifiers.length > 0) {
                 insertPosOffset = existingSpecifiers[existingSpecifiers.length - 1].getEnd();
             } else {
                insertPosOffset = clause.namedBindings.getStart() + 1;
                const braceText = clause.namedBindings.getText(sourceFile);
                if (braceText.length > 2 && /^\{\s*\}\s*$/.test(braceText)) {
                    insertPosOffset = clause.namedBindings.getEnd() - 1;
                }
            }
            const textToInsert = existingSpecifiers.length > 0 ? `, ${newSpecifierText}` : newSpecifierText;
            const specifierInsertPosition = documentToEdit.positionAt(insertPosOffset); 
            fileEdits.push(TextEdit.insert(specifierInsertPosition, textToInsert));
            console.log(`[generateExplicitEdits] Added specifier edit for ${fileUri.fsPath}`);
        } else {
            console.warn(`[generateExplicitEdits] Could not add customElement specifier to existing import for ${fileUri.fsPath} (type: ${importInfo.existingImportNode?.kind}), may need manual fix.`);
            // Fallback: Add separate import line (already handled by needsNewImport logic potentially, but could log warning)
        }
    }

    // Build Decorator
    const kebabName = toKebabCase(className!); 
    const decoratorArgParts: string[] = [`name: '${kebabName}'`];
    if (templateImportPath) decoratorArgParts.push(`template`);
    const decoratorArg = `{ ${decoratorArgParts.join(', ')} }`;
    const decoratorText = `@customElement(${decoratorArg})\n`;
    const classStartOffset = classNode.getStart(sourceFile);
    fileEdits.push(TextEdit.insert(documentToEdit.positionAt(classStartOffset), decoratorText));

    return fileEdits;
}

async function generateImplicitEdits(
    documentToEdit: TextDocument,
    sourceFile: ts.SourceFile,
    classNode: ts.ClassDeclaration,
    decoratorToRemove: ts.Decorator // Pass decorator found by caller
): Promise<TextEdit[]> {
    const fileEdits: TextEdit[] = [];
    const fileUri = documentToEdit.uri;
    const fileContent = documentToEdit.getText();
    const baseName = path.basename(fileUri.fsPath, '.ts');

    // 1. Remove Decorator
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
    const rangeToRemoveDecorator = new Range(documentToEdit.positionAt(startPos), documentToEdit.positionAt(decoratorEnd));
    fileEdits.push(TextEdit.delete(rangeToRemoveDecorator));

    // 2. Find and Remove Associated Imports
    const expectedTemplateImportPath = `./${baseName}.html`;
    const expectedCssImportPath = `./${baseName}.css`;
    const expectedScssImportPath = `./${baseName}.scss`;
    let customElementImportInfo: { node: ts.ImportDeclaration, isOnlySpecifier: boolean, specifierNode: ts.ImportSpecifier | null } | null ;

    ts.forEachChild(sourceFile, node => {
        if (ts.isImportDeclaration(node)) {
            const moduleSpecifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
            const importClause = node.importClause;
            if ((moduleSpecifier === expectedTemplateImportPath && importClause?.name) ||
                ((moduleSpecifier === expectedCssImportPath || moduleSpecifier === expectedScssImportPath) && !importClause)) {
                fileEdits.push(TextEdit.delete(getFullLineRangeIncludingNewline(documentToEdit, node.getStart(sourceFile), node.getEnd())));
            }
            else if (moduleSpecifier === '@aurelia/runtime-html' || moduleSpecifier === 'aurelia') {
                 if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
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
    customElementImportInfo ??= null; // Ensure null if not found

    // 3. Add Edit for customElement Import Removal
    if (customElementImportInfo) {
        const checkedImportInfo = customElementImportInfo!;
        if (checkedImportInfo.isOnlySpecifier) {
            fileEdits.push(TextEdit.delete(getFullLineRangeIncludingNewline(documentToEdit, checkedImportInfo.node.getStart(sourceFile), checkedImportInfo.node.getEnd())));
        } else if (checkedImportInfo.specifierNode) {
            const specifierNode = checkedImportInfo.specifierNode;
            let specifierStart = specifierNode.getStart(sourceFile);
            let specifierEnd = specifierNode.getEnd();
            const namedBindings = checkedImportInfo.node.importClause?.namedBindings as ts.NamedImports;
            const elements = namedBindings.elements;
            const textBefore = fileContent.substring(0, specifierStart);
            const textAfter = fileContent.substring(specifierEnd);
            const preCommaMatch = textBefore.match(/,\s*$/);
            if (preCommaMatch) {
                specifierStart -= preCommaMatch[0].length;
            } else {
                 const postCommaMatch = textAfter.match(/^\s*,/);
                 if (postCommaMatch) {
                     specifierEnd += postCommaMatch[0].length;
                 }
            }
            fileEdits.push(TextEdit.delete(new Range(documentToEdit.positionAt(specifierStart), documentToEdit.positionAt(specifierEnd))));
        }
    }

    return fileEdits;
}

// --- Core Folder Processing Function ---

type FileProcessor = (
    documentToEdit: TextDocument,
    sourceFile: ts.SourceFile,
    classNode: ts.ClassDeclaration
) => Promise<TextEdit[]>;

async function processFolderViewModelFiles(
    folderUri: Uri,
    processor: FileProcessor,
    progress: Progress<{ message?: string; increment?: number }>, // Use imported Progress type
    token: CancellationToken // Use imported CancellationToken type
): Promise<{ appliedCount: number; errorCount: number }> {

    const pattern = new RelativePattern(folderUri, '**/*.ts');
    const tsFiles = await workspace.findFiles(pattern);
    let appliedCount = 0;
    let errorCount = 0;
    const totalFiles = tsFiles.length;

    progress.report({ message: `Found ${totalFiles} TS files. Processing...`, increment: 0 });

    for (let i = 0; i < totalFiles; i++) {
        const fileUri = tsFiles[i];
        if (token.isCancellationRequested) break;
        const baseName = path.basename(fileUri.fsPath);
        // Use a smaller increment step for processing each file
        const incrementAmount = totalFiles > 0 ? (1 / totalFiles) * 100 : 0;
        progress.report({ message: `Processing ${i + 1}/${totalFiles}: ${baseName}...`, increment: incrementAmount / 2 }); // Half increment for check/process

        try {
            // Check for HTML pair first 
            const currentDir = path.dirname(fileUri.fsPath);
            const potentialHtmlPath = path.join(currentDir, `${path.basename(baseName, '.ts')}.html`);
            if (!fs.existsSync(potentialHtmlPath)) {
                continue; // Skip if no HTML pair
            }

            // Open document and parse
            const documentToEdit = await workspace.openTextDocument(fileUri);
            const fileContent = documentToEdit.getText();
            const sourceFile = ts.createSourceFile(fileUri.fsPath, fileContent, ts.ScriptTarget.Latest, true);

            // Find exported class
            let classNode: ts.ClassDeclaration | undefined;
            try { classNode = findExportedClassNode(sourceFile); } catch { continue; } // Skip if no exported class

            // Call the specific processor to get edits
            const fileEdits = await processor(documentToEdit, sourceFile, classNode);

            // <<< Log the generated edits >>>
            if (fileEdits.length > 0) {
                 console.log(`[FolderCommand] Generated ${fileEdits.length} edits for ${fileUri.fsPath}:`);
                 fileEdits.forEach((edit, i) => console.log(`  - Edit ${i}: ${JSON.stringify(edit)}`));
            } else {
                console.log(`[FolderCommand] No edits needed for ${fileUri.fsPath}.`);
            }

            // Apply edits for this file if any were generated
            if (fileEdits.length > 0) {
                const fileWorkspaceEdit = new WorkspaceEdit();
                fileEdits.sort((a, b) => b.range.start.compareTo(a.range.start)); // Sort descending
                fileWorkspaceEdit.set(fileUri, fileEdits);
                // <<< Log before applying >>>
                console.log(`[FolderCommand] Applying ${fileEdits.length} edits to ${fileUri.fsPath}...`); 
                const success = await workspace.applyEdit(fileWorkspaceEdit);
                 // <<< Log result of applyEdit >>>
                 console.log(`[FolderCommand] Apply edits success for ${fileUri.fsPath}: ${success}`);
                if (success) {
                    await documentToEdit.save();
                    appliedCount++;
                } else {
                    console.error(`[FolderCommand] Failed to apply edits for ${fileUri.fsPath}`);
                    errorCount++;
                }
            }
        } catch (e: any) {
            console.error(`[FolderCommand] Error processing file ${fileUri.fsPath}: ${e.message}`);
            errorCount++;
        }
         progress.report({ increment: incrementAmount / 2 }); // Second half of increment
    }
    // Ensure progress reaches 100% at the end if not cancelled
     if (!token.isCancellationRequested) {
        progress.report({ increment: 100, message: 'Finishing...' });
    }
    return { appliedCount, errorCount };
}

// ... deactivate ...