"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const vscode_uri_1 = require("vscode-uri");
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
const logger_1 = require("./utils/logger");
const settings_1 = require("./common/settings");
const virtualFileProvider_1 = require("./core/virtualFileProvider");
const componentScanner_1 = require("./core/componentScanner");
const languageServiceProvider_1 = require("./core/languageServiceProvider");
const completionProvider_1 = require("./featureProviders/completionProvider");
const definitionProvider_1 = require("./featureProviders/definitionProvider");
const hoverProvider_1 = require("./featureProviders/hoverProvider");
const signatureHelpProvider_1 = require("./featureProviders/signatureHelpProvider");
const semanticTokensProvider_1 = require("./featureProviders/semanticTokensProvider");
const referencesProvider_1 = require("./featureProviders/referencesProvider");
const renameProvider_1 = require("./featureProviders/renameProvider");
const codeActionProvider_1 = require("./featureProviders/codeActionProvider");
const documentFormattingProvider_1 = require("./featureProviders/documentFormattingProvider");
// --- State ---
let languageService;
let virtualFiles = new Map(); // virtualUri -> content/version
let aureliaDocuments = new Map(); // htmlUri -> info
let strictMode = false;
let workspaceRoot = process.cwd(); // Store workspace root
let aureliaProjectComponents = new Map();
let viewModelMembersCache = new Map();
let componentUpdateTimer;
const componentUpdateQueue = new Set();
const COMPONENT_UPDATE_DEBOUNCE_MS = 500;
// +++ Initialize Logger +++
(0, logger_1.initializeLogger)(connection, settings_1.serverSettings);
connection.onInitialize((params) => {
    workspaceRoot = params.rootUri ? vscode_uri_1.URI.parse(params.rootUri).fsPath : params.rootPath || process.cwd();
    strictMode = params.initializationOptions?.strictMode ?? false;
    // +++ Call imported createLanguageServiceInstance with dependencies object +++
    languageService = (0, languageServiceProvider_1.createLanguageServiceInstance)({
        workspaceRoot,
        documents,
        virtualFiles,
        strictMode
    });
    // Scan workspace AFTER language service is created
    (0, componentScanner_1.scanWorkspaceForAureliaComponents)(languageService, workspaceRoot, aureliaProjectComponents);
    (0, logger_1.log)('info', `[Initialize] Initial scan complete. Found ${aureliaProjectComponents.size} components/attributes.`);
    (0, logger_1.log)('info', `[Initialize] Aurelia language server initializing in ${workspaceRoot}.`);
    const result = {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ['.', '{', '(', '=', '<', ' ']
            },
            renameProvider: {
                prepareProvider: true,
            },
            definitionProvider: true,
            hoverProvider: true,
            signatureHelpProvider: { triggerCharacters: ['(', ','] },
            codeActionProvider: true,
            documentFormattingProvider: true,
            semanticTokensProvider: {
                legend: semanticTokensProvider_1.legend,
                full: true,
            },
            referencesProvider: true,
            workspace: {
                workspaceFolders: {
                    supported: true,
                    changeNotifications: true
                }
            }
        },
    };
    return result;
});
documents.onDidChangeContent((change) => {
    // +++ Add log to check if handler is called for TS files +++
    (0, logger_1.log)('debug', `[onDidChangeContent] Handler called for URI: ${change.document.uri}`);
    // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
    const uri = change.document.uri;
    const fsPath = vscode_uri_1.URI.parse(uri).fsPath;
    const htmlUriString = vscode_uri_1.URI.parse(uri).toString();
    if (uri.endsWith('.html')) {
        // +++ Proactively invalidate cache for the ASSOCIATED ViewModel +++
        const docInfo = aureliaDocuments.get(htmlUriString);
        if (docInfo && docInfo.vmFsPath) {
            (0, logger_1.log)('info', `[onDidChangeContent] HTML file ${uri} changed. Proactively invalidating cache for VM: ${docInfo.vmFsPath}`);
            viewModelMembersCache.delete(docInfo.vmFsPath);
        }
        // +++ END Invalidate Cache +++
        // Now update the virtual file (it will refetch members if cache was invalidated)
        (0, virtualFileProvider_1.updateVirtualFile)(htmlUriString, change.document.getText(), aureliaDocuments, virtualFiles, languageService, documents, connection, viewModelMembersCache);
    }
    else if (uri.endsWith('.ts')) {
        // Invalidate cache DIRECTLY when the TS file changes (Keep this)
        (0, logger_1.log)('info', `[onDidChangeContent] ViewModel ${uri} changed. Invalidating cache for ${fsPath}`);
        viewModelMembersCache.delete(fsPath);
        // Find open HTML documents associated with this TS file and update them
        for (const [htmlUriKey, relatedDocInfo] of aureliaDocuments.entries()) {
            if (relatedDocInfo.vmFsPath === fsPath) {
                const htmlDoc = documents.get(htmlUriKey);
                if (htmlDoc) {
                    (0, logger_1.log)('info', `[onDidChangeContent] Triggering virtual file update for OPEN document: ${htmlUriKey}`);
                    // Delay might still be useful here, keeping it for now
                    setTimeout(() => {
                        const currentHtmlDoc = documents.get(htmlUriKey);
                        if (currentHtmlDoc) {
                            (0, logger_1.log)('info', `[onDidChangeContent][Delayed] Updating virtual file for ${htmlUriKey} after TS change.`);
                            (0, virtualFileProvider_1.updateVirtualFile)(currentHtmlDoc.uri, currentHtmlDoc.getText(), aureliaDocuments, virtualFiles, languageService, documents, connection, viewModelMembersCache);
                        }
                    }, 500);
                }
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
            (0, logger_1.log)('info', `[onDidClose] Cleaned up resources for ${htmlUriString}`);
        }
    }
});
connection.onDidChangeConfiguration((_params) => {
    // Keep this handler simple - only log config change for now
    (0, logger_1.log)('info', "[onDidChangeConfiguration] Configuration changed (re-initialization might be needed for some settings).");
});
// Handle watched file changes for components (with debouncing)
connection.onDidChangeWatchedFiles((params) => {
    // +++ Add log to check if handler is called +++
    (0, logger_1.log)('debug', `[onDidChangeWatchedFiles] Handler called. Changes: ${JSON.stringify(params.changes.map(c => ({ uri: c.uri, type: c.type })))}`);
    // ++++++++++++++++++++++++++++++++++++++++++++++
    (0, logger_1.log)('info', '[onDidChangeWatchedFiles] Received file changes.');
    let changedUrisForProcessing = false;
    for (const change of params.changes) {
        const fileUri = change.uri;
        if (!fileUri.endsWith('.ts') || fileUri.includes('node_modules')) {
            continue;
        }
        connection.console.log(`  - Change Type: ${change.type}, File: ${fileUri}`);
        if (change.type === node_1.FileChangeType.Deleted) {
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
        }
        else {
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
            (0, logger_1.log)('info', `[File Watch Debounce] Processing ${componentUpdateQueue.size} queued file changes...`);
            const urisToProcess = new Set(componentUpdateQueue); // Copy queue
            componentUpdateQueue.clear(); // Clear original queue
            let needsFullRescanOnError = false;
            urisToProcess.forEach(uri => {
                try {
                    const changedFsPath = vscode_uri_1.URI.parse(uri).fsPath;
                    (0, logger_1.log)('debug', `[File Watch Debounce] Processing change for: ${changedFsPath}`);
                    // 1. Update component info (existing logic)
                    const componentMapChanged = (0, componentScanner_1.updateComponentInfoForFile)(uri, languageService, workspaceRoot, aureliaProjectComponents);
                    if (componentMapChanged) {
                        (0, logger_1.log)('info', `[File Watch Debounce] Component map potentially updated by change to ${uri}`);
                        // Future: Could potentially trigger targeted updates based on this
                    }
                    // +++ 2. Check if it's a ViewModel for any OPEN Aurelia documents +++
                    for (const [htmlUriKey, docInfo] of aureliaDocuments.entries()) {
                        if (docInfo.vmFsPath === changedFsPath) {
                            // This TS file is a ViewModel for an existing AureliaDocumentInfo
                            const openHtmlDoc = documents.get(htmlUriKey); // Check if the corresponding HTML doc is open
                            if (openHtmlDoc) {
                                (0, logger_1.log)('info', `[File Watch Debounce] Watched ViewModel ${changedFsPath} changed. Triggering virtual file update for OPEN document: ${htmlUriKey}`);
                                // Regenerate the virtual file for the open HTML document
                                (0, virtualFileProvider_1.updateVirtualFile)(openHtmlDoc.uri, openHtmlDoc.getText(), aureliaDocuments, virtualFiles, languageService, documents, connection, viewModelMembersCache);
                            }
                            else {
                                (0, logger_1.log)('debug', `[File Watch Debounce] Watched ViewModel ${changedFsPath} changed, but associated HTML doc ${htmlUriKey} is not open. Virtual file will update on open.`);
                            }
                            // Assuming one VM per HTML for now, could potentially break if multiple HTML use same VM?
                            // For now, let's assume we might need to check all open docs.
                            // break; // Remove break if multiple HTML files could use the same VM
                        }
                    }
                    // +++ END ViewModel Check +++
                }
                catch (e) {
                    (0, logger_1.log)('error', `  -> Error processing queued file change ${uri}: ${e}`);
                    needsFullRescanOnError = true;
                }
            });
            if (needsFullRescanOnError) {
                connection.console.warn('[File Watch Debounce] Triggering full rescan due to errors during processing.');
                // +++ Call imported scanWorkspaceForAureliaComponents +++
                (0, componentScanner_1.scanWorkspaceForAureliaComponents)(languageService, workspaceRoot, aureliaProjectComponents); // Fallback to full scan on error
            }
            componentUpdateTimer = undefined; // Clear timer reference
        }, COMPONENT_UPDATE_DEBOUNCE_MS);
    }
});
// --- Completion --- 
connection.onCompletion((params) => {
    // +++ Call imported handler +++
    return (0, completionProvider_1.handleCompletionRequest)(params, documents, aureliaDocuments, aureliaProjectComponents, languageService, viewModelMembersCache);
});
// --- Definition ---
connection.onDefinition(async (params) => {
    // +++ Call imported handler +++
    return (0, definitionProvider_1.handleDefinitionRequest)(params, documents, // Pass state
    aureliaDocuments, // Pass state
    languageService, // Pass dependency
    aureliaProjectComponents // <<< Add the component map here
    );
});
// --- Semantic Tokens ---
connection.languages.semanticTokens.on(async (params) => {
    // +++ Call imported handler +++
    return (0, semanticTokensProvider_1.handleSemanticTokensRequest)(params, documents, aureliaDocuments, virtualFiles, // Pass state
    languageService, aureliaProjectComponents // <<< Pass the component map here
    );
});
// --- Document Formatting (Placeholder) ---
connection.onDocumentFormatting(async (params) => {
    // +++ Call imported handler +++
    return (0, documentFormattingProvider_1.handleDocumentFormattingRequest)(params, documents);
});
// --- Code Actions ---
connection.onCodeAction(async (params) => {
    // +++ Call imported handler +++
    return (0, codeActionProvider_1.handleCodeActionRequest)(params, documents, aureliaDocuments, languageService);
});
// --- Rename Prepare ---
connection.onPrepareRename(async (params) => {
    // +++ Call imported handler +++
    return (0, renameProvider_1.handlePrepareRenameRequest)(params, documents, aureliaDocuments, languageService);
});
// --- Rename Request ---
connection.onRenameRequest(async (params) => {
    // +++ Call imported handler with cache +++
    return (0, renameProvider_1.handleRenameRequest)(params, documents, aureliaDocuments, languageService, viewModelMembersCache);
});
// --- Hover --- 
connection.onHover(async (params) => {
    // +++ Call imported handler +++
    return (0, hoverProvider_1.handleHoverRequest)(params, documents, // Pass state
    aureliaDocuments, // Pass state
    languageService, // Pass dependency
    aureliaProjectComponents // <<< Add the component map here
    );
});
// --- Signature Help --- 
connection.onSignatureHelp(async (params) => {
    // +++ Call imported handler +++
    return (0, signatureHelpProvider_1.handleSignatureHelpRequest)(params, documents, // Pass state
    aureliaDocuments, // Pass state
    languageService // Pass dependency
    );
});
// --- Find References --- 
connection.onReferences(async (params) => {
    // +++ Call imported handler +++
    return (0, referencesProvider_1.handleReferencesRequest)(params, documents, aureliaDocuments, languageService);
});
// --- Server Listen ---
connection.listen();
documents.listen(connection); // Start listening for document changes on connected document manager
connection.onShutdown(() => {
    (0, logger_1.log)('info', 'Aurelia language server shutting down.');
    // Dispose language service? (Potentially needed)
});
//# sourceMappingURL=server.js.map