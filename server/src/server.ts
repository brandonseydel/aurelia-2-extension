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
  DefinitionParams,
  LocationLink,
  Range as LSPRange,
  Hover,
  HoverParams,
  SignatureHelp,
  SignatureHelpParams,
  CodeAction,
  CodeActionParams,
  WorkspaceEdit,
  TextEdit,
  DocumentFormattingParams,
  SemanticTokens,
  SemanticTokensParams,
  FileChangeType,
  PrepareRenameParams,
  RenameParams,
  ReferenceParams,
  Location as LSPLocation,
  DidChangeWatchedFilesNotification,
  RelativePattern,
  WatchKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

type SignatureHelpTriggerCharacter = ts.SignatureHelpTriggerCharacter;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

import {
  AureliaDocumentInfo,
  AureliaProjectComponentMap
} from './common/types';
import { initializeLogger, log } from './utils/logger';
import { serverSettings } from './common/settings';
import { updateVirtualFile } from './core/virtualFileProvider';
import { scanWorkspaceForAureliaComponents, updateComponentInfoForFile, scanWorkspaceForHtmlOnlyComponents } from './core/componentScanner';
import { populateAureliaDocumentsFromComponents } from './core/projectScanner';
import { createLanguageServiceInstance } from './core/languageServiceProvider';
import { handleCompletionRequest } from './featureProviders/completionProvider';
import { handleDefinitionRequest } from './featureProviders/definitionProvider';
import { handleHoverRequest } from './featureProviders/hoverProvider';
import { handleSignatureHelpRequest } from './featureProviders/signatureHelpProvider';
import { handleSemanticTokensRequest, legend as semanticTokensLegend } from './featureProviders/semanticTokensProvider';
import { handleReferencesRequest } from './featureProviders/referencesProvider';
import { handlePrepareRenameRequest, handleRenameRequest } from './featureProviders/renameProvider';
import { handleCodeActionRequest } from './featureProviders/codeActionProvider';
import { handleDocumentFormattingRequest } from './featureProviders/documentFormattingProvider';

// --- State ---
let languageService: ts.LanguageService;
let program: ts.Program | undefined;
let virtualFiles: Map<string, { content: string; version: number }> = new Map(); // virtualUri -> content/version
let aureliaDocuments: Map<string, AureliaDocumentInfo> = new Map(); // htmlUri -> info
let strictMode = false;
let workspaceRoot = process.cwd(); // Store workspace root
let aureliaProjectComponents: AureliaProjectComponentMap = new Map();
let viewModelMembersCache: Map<string, { content: string | undefined; members: string[] }> = new Map();

let componentUpdateTimer: NodeJS.Timeout | undefined;
const componentUpdateQueue = new Set<string>();
const COMPONENT_UPDATE_DEBOUNCE_MS = 500;

// +++ Initialize Logger +++
initializeLogger(connection, serverSettings);

connection.onInitialize(async (params: InitializeParams) => {
  workspaceRoot = params.rootUri ? URI.parse(params.rootUri).fsPath : params.rootPath || process.cwd();
  strictMode = params.initializationOptions?.strictMode ?? false;

  log('info', `[Initialize] Aurelia language server initializing in ${workspaceRoot}.`);

  // +++ Call imported createLanguageServiceInstance with dependencies object +++
  languageService = createLanguageServiceInstance({
    workspaceRoot,
    documents,
    virtualFiles,
    strictMode
  });

  program = languageService.getProgram();
  log('info', `[Initialize] Language service created.`);

  // Step 1a: Scan workspace for TS component definitions 
  scanWorkspaceForAureliaComponents(languageService, workspaceRoot, aureliaProjectComponents, program);
  log('info', `[Initialize] Initial TS component scan complete. Found ${aureliaProjectComponents.size} components/attributes.`);

  // <<< Step 1b: Scan workspace for HTML-only component definitions >>>
  await scanWorkspaceForHtmlOnlyComponents(workspaceRoot, aureliaProjectComponents);
  log('info', `[Initialize] HTML-only component scan complete. Total components now: ${aureliaProjectComponents.size}.`);

  // Step 2: Populate aureliaDocuments and virtualFiles based on discovered components
  await populateAureliaDocumentsFromComponents(
    aureliaProjectComponents,
    documents,
    aureliaDocuments,
    virtualFiles,
    languageService,
    connection,
    viewModelMembersCache,
    program,
  );
  log('info', `[Initialize] Aurelia documents populated. Found ${aureliaDocuments.size} view/vm pairs.`);

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
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
        legend: semanticTokensLegend,
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

// Runs after the server has been initialized and capabilities negotiated
connection.onInitialized(() => {
  // Register for file watching
  connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [
      {
        // Construct RelativePattern object directly
        globPattern: {
          baseUri: URI.file(workspaceRoot).toString(),
          pattern: '**/*.ts'
        },
        kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete
      }
    ]
  });
  log('info', '[onInitialized] File watcher registered for **/*.ts files.');
});

documents.onDidChangeContent((change) => {
  // +++ Add log to check if handler is called for TS files +++
  log('debug', `[onDidChangeContent] Handler called for URI: ${change.document.uri}`);
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

  const uri = change.document.uri;
  const fsPath = URI.parse(uri).fsPath;
  const htmlUriString = URI.parse(uri).toString();

  if (uri.endsWith('.html')) {
    // +++ Proactively invalidate cache for the ASSOCIATED ViewModel +++
    const docInfo = aureliaDocuments.get(htmlUriString);
    if (docInfo && docInfo.vmFsPath) {
      log('info', `[onDidChangeContent] HTML file ${uri} changed. Proactively invalidating cache for VM: ${docInfo.vmFsPath}`);
      viewModelMembersCache.delete(docInfo.vmFsPath);
    }
    // +++ END Invalidate Cache +++

    // Now update the virtual file (it will refetch members if cache was invalidated)
    updateVirtualFile(
      htmlUriString,
      change.document.getText(),
      aureliaDocuments,
      virtualFiles,
      languageService,
      documents,
      connection,
      viewModelMembersCache,
      aureliaProjectComponents,
      program
    );
  } else if (uri.endsWith('.ts')) {
    // Invalidate cache DIRECTLY when the TS file changes (Keep this)
    log('info', `[onDidChangeContent] ViewModel ${uri} changed. Invalidating cache for ${fsPath}`);
    viewModelMembersCache.delete(fsPath);

    // Find open HTML documents associated with this TS file and update them
    for (const [htmlUriKey, relatedDocInfo] of aureliaDocuments.entries()) {
      if (relatedDocInfo.vmFsPath === fsPath) {
        const htmlDoc = documents.get(htmlUriKey);
        if (htmlDoc) {
          log('info', `[onDidChangeContent] Triggering virtual file update for OPEN document: ${htmlUriKey}`);
          // Delay might still be useful here, keeping it for now
          setTimeout(() => {
            const currentHtmlDoc = documents.get(htmlUriKey);
            if (currentHtmlDoc) {
              log('info', `[onDidChangeContent][Delayed] Updating virtual file for ${htmlUriKey} after TS change.`);
              updateVirtualFile(
                currentHtmlDoc.uri,
                currentHtmlDoc.getText(),
                aureliaDocuments,
                virtualFiles,
                languageService,
                documents,
                connection,
                viewModelMembersCache,
                aureliaProjectComponents,
                program
              );
            }
          }, 500);
        }
      }
    }
  }
  program = languageService.getProgram(); // Update program reference after virtual file update

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
  // Keep this handler simple - only log config change for now
  log('info', "[onDidChangeConfiguration] Configuration changed (re-initialization might be needed for some settings).");
});

// Handle watched file changes for components (with debouncing)
connection.onDidChangeWatchedFiles((params) => {

  program = languageService.getProgram();
  // +++ Add log to check if handler is called +++
  log('debug', `[onDidChangeWatchedFiles] Handler called. Changes: ${JSON.stringify(params.changes.map(c => ({ uri: c.uri, type: c.type })))}`);
  // ++++++++++++++++++++++++++++++++++++++++++++++

  log('info', '[onDidChangeWatchedFiles] Received file changes.');
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
      log('info', `[File Watch Debounce] Processing ${componentUpdateQueue.size} queued file changes...`);
      const urisToProcess = new Set(componentUpdateQueue); // Copy queue
      componentUpdateQueue.clear(); // Clear original queue

      let needsFullRescanOnError = false;
      let anyComponentMapChanged = false; // <<< Add flag to track changes

      urisToProcess.forEach(uri => {
        try {
          const changedFsPath = URI.parse(uri).fsPath;
          log('debug', `[File Watch Debounce] Processing change for: ${changedFsPath}`)

          // 1. Update component info (existing logic)
          const componentMapChanged = updateComponentInfoForFile(uri, languageService, workspaceRoot, aureliaProjectComponents, program);
          if (componentMapChanged) {
            log('info', `[File Watch Debounce] Component map potentially updated by change to ${uri}`);
            anyComponentMapChanged = true; // <<< Set flag if map changed
          }

          // +++ 2. Check if it's a ViewModel for any OPEN Aurelia documents +++
          for (const [htmlUriKey, docInfo] of aureliaDocuments.entries()) {
            if (docInfo.vmFsPath === changedFsPath) {
              // This TS file is a ViewModel for an existing AureliaDocumentInfo
              const openHtmlDoc = documents.get(htmlUriKey); // Check if the corresponding HTML doc is open
              if (openHtmlDoc) {
                log('info', `[File Watch Debounce] Watched ViewModel ${changedFsPath} changed. Triggering virtual file update for OPEN document: ${htmlUriKey}`);
                // Regenerate the virtual file for the open HTML document
                updateVirtualFile(
                  openHtmlDoc.uri,
                  openHtmlDoc.getText(),
                  aureliaDocuments,
                  virtualFiles,
                  languageService,
                  documents,
                  connection,
                  viewModelMembersCache,
                  aureliaProjectComponents,
                  program
                );

              } else {
                log('debug', `[File Watch Debounce] Watched ViewModel ${changedFsPath} changed, but associated HTML doc ${htmlUriKey} is not open. Virtual file will update on open.`);
              }
              // Assuming one VM per HTML for now, could potentially break if multiple HTML use same VM?
              // For now, let's assume we might need to check all open docs.
              // break; // Remove break if multiple HTML files could use the same VM
            }
          }

          // +++ END ViewModel Check +++

        } catch (e) {
          log('error', `  -> Error processing queued file change ${uri}: ${e}`);
          needsFullRescanOnError = true;
        }
      });

      // If any error occurred, trigger a full rescan
      if (needsFullRescanOnError) {
        log('warn', `[File Watch Debounce] Triggering full component rescan due to processing error.`);
        // Trigger full scan after a short delay
        if (componentUpdateTimer) clearTimeout(componentUpdateTimer);
        componentUpdateTimer = setTimeout(() => {
          log('info', '[File Watch Debounce] Triggering full rescan due to processing error.');
          scanWorkspaceForAureliaComponents(languageService, workspaceRoot, aureliaProjectComponents, program);
        }, 500);
      }
      // +++ Add check for map changes to trigger update signal +++
      else if (anyComponentMapChanged) { // <<< Check the flag after processing all files
        log('info', '[File Watch Debounce] Component map was updated. Requesting semantic token refresh.');
        // Request the client to refresh semantic tokens
        connection.languages.semanticTokens.refresh();
      }
    }, COMPONENT_UPDATE_DEBOUNCE_MS);
  }
});

// --- Completion --- 
connection.onCompletion((params: CompletionParams): CompletionItem[] | undefined => {
  // +++ Call imported handler +++
  return handleCompletionRequest(
    params,
    documents,
    aureliaDocuments,
    aureliaProjectComponents,
    languageService,
    viewModelMembersCache,
    virtualFiles,
    program,
  );
});

// --- Definition ---
connection.onDefinition(async (params: DefinitionParams): Promise<LocationLink[] | undefined> => {
  // +++ Call imported handler +++
  return handleDefinitionRequest(
    params,
    documents,          // Pass state
    aureliaDocuments,   // Pass state
    languageService,    // Pass dependency
    aureliaProjectComponents,
    program // <<< Add the component map here
  );
});

// --- Semantic Tokens ---
connection.languages.semanticTokens.on(async (params: SemanticTokensParams): Promise<SemanticTokens> => {
  // +++ Call imported handler +++
  return handleSemanticTokensRequest(
    params,
    documents,
    aureliaDocuments,
    virtualFiles, // Pass state
    languageService,
    aureliaProjectComponents, // <<< Pass the component map here
  );
});

// --- Document Formatting (Placeholder) ---
connection.onDocumentFormatting(async (params: DocumentFormattingParams): Promise<TextEdit[]> => {
  // +++ Call imported handler +++
  return handleDocumentFormattingRequest(
    params,
    documents
  );
});

// --- Code Actions ---
connection.onCodeAction(async (params: CodeActionParams): Promise<CodeAction[] | undefined> => {
  // +++ Call imported handler +++
  return handleCodeActionRequest(
    params,
    documents,
    aureliaDocuments,
    languageService
  );
});

// --- Rename Prepare ---
connection.onPrepareRename(async (params: PrepareRenameParams): Promise<LSPRange | { range: LSPRange, placeholder: string } | null> => {
  // +++ Call imported handler with component map +++
  return handlePrepareRenameRequest(
    params,
    documents,
    aureliaDocuments,
    languageService,
    aureliaProjectComponents,
    languageService.getProgram(),
  );
});

// --- Rename Request ---
connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | undefined> => {
  // +++ Call imported handler with cache +++
  return handleRenameRequest(
    params,
    documents,
    aureliaDocuments,
    languageService,
    aureliaProjectComponents,
    program,
  );
});

// --- Hover --- 
connection.onHover(async (params: HoverParams): Promise<Hover | undefined> => {
  // +++ Call imported handler +++
  return handleHoverRequest(
    params,
    documents,          // Pass state
    aureliaDocuments,   // Pass state
    languageService,    // Pass dependency
    aureliaProjectComponents,
    program             // <<< Pass program
  );
});

// --- Signature Help --- 
connection.onSignatureHelp(async (params: SignatureHelpParams): Promise<SignatureHelp | undefined> => {
  // +++ Call imported handler +++
  return handleSignatureHelpRequest(
    params,
    documents,          // Pass state
    aureliaDocuments,   // Pass state
    languageService     // Pass dependency
  );
});

// --- Find References --- 
connection.onReferences(async (params: ReferenceParams): Promise<LSPLocation[] | undefined> => {
  // +++ Call imported handler +++
  return handleReferencesRequest(
    params,
    documents,
    aureliaDocuments,
    languageService,
    aureliaProjectComponents // <<< Pass the component map here
  );
});

// --- Server Listen ---
connection.listen();
documents.listen(connection); // Start listening for document changes on connected document manager
connection.onShutdown(() => {
  log('info', 'Aurelia language server shutting down.');
  // Dispose language service? (Potentially needed)
});