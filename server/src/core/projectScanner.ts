import * as vscode from 'vscode-languageserver';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver';

import { AureliaDocumentInfo, AureliaProjectComponentMap, AureliaComponentInfo } from '../common/types';
import { log } from '../utils/logger';
import { updateVirtualFile } from './virtualFileProvider';
import { fileExistsOnDisk, toKebabCase } from '../utils/utilities';
// We'll need access to languageService, caches etc. - these will need to be passed in.
import * as ts from 'typescript';

const MAX_CONCURRENT_UPDATES = 10; // Adjust as needed

/**
 * Iterates through the discovered Aurelia components and populates the
 * aureliaDocuments and virtualFiles maps by calling updateVirtualFile for each view/viewmodel pair.
 * This should run AFTER the initial component scan that populates aureliaProjectComponentMap.
 *
 * @param aureliaProjectComponentMap The map of discovered Aurelia components (populated by componentScanner).
 * @param documents The TextDocuments manager.
 * @param aureliaDocuments The map to populate with AureliaDocumentInfo.
 * @param virtualFiles The map to populate with virtual file content.
 * @param languageService The TypeScript language service.
 * @param connection The LSP connection.
 * @param viewModelMembersCache Cache for ViewModel members.
 */
export async function populateAureliaDocumentsFromComponents(
    aureliaProjectComponentMap: AureliaProjectComponentMap,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    virtualFiles: Map<string, { content: string; version: number }>,
    languageService: ts.LanguageService,
    connection: vscode.Connection,
    viewModelMembersCache: Map<string, { content: string | undefined; members: string[] }>,
    program: ts.Program | undefined,
): Promise<void> {
    log('info', '[ProjectScanner] Starting population of Aurelia documents based on discovered components...');

    let processedCount = 0;
    let errorCount = 0;
    let skippedAttributeCount = 0;

    const updateTasks: Promise<void>[] = [];
    const componentsToProcess: AureliaComponentInfo[] = [];

    // First, gather all element components to process
    for (const componentInfo of aureliaProjectComponentMap.values()) {
        if (componentInfo.type === 'element') {
            componentsToProcess.push(componentInfo);
        } else {
            skippedAttributeCount++;
        }
    }
    log('info', `[ProjectScanner] Found ${componentsToProcess.length} element components to process.`);

    // Function to process a single component
    const processComponent = async (componentInfo: AureliaComponentInfo) => {
        const tsPath = URI.parse(componentInfo.uri).fsPath;
        const dirName = path.dirname(tsPath);
        const htmlFileName = `${componentInfo.name}.html`;
        const htmlPath = path.join(dirName, htmlFileName);
        const htmlUri = URI.file(htmlPath).toString();

        if (fileExistsOnDisk(htmlPath)) {
            try {
                // Read file first
                const htmlContent = await fs.promises.readFile(htmlPath, 'utf-8');
                
                // Defer the CPU/TS-intensive part
                setImmediate(() => {
                    log('debug', `[ProjectScanner][Deferred] Processing Element pair: ${htmlPath} / ${tsPath}`);
                    try {
                        updateVirtualFile(
                            htmlUri,
                            htmlContent, // Use content read earlier
                            aureliaDocuments,
                            virtualFiles,
                            languageService,
                            documents,
                            connection,
                            viewModelMembersCache,
                            aureliaProjectComponentMap,
                            program,
                        );
                        // Note: counters are now less meaningful here as the outer promise resolves sooner
                        // Consider moving counting logic elsewhere if precise counts after completion are needed
                    } catch (deferredError) {
                         log('error', `[ProjectScanner][Deferred] Error processing component view ${htmlPath}:`, deferredError);
                         // errorCount++; // Counter is less reliable here
                    }
                });
                 processedCount++; // Increment processed count after scheduling

            } catch (readError) {
                // Handle error during the async file read itself
                log('error', `[ProjectScanner] Error reading component view file ${htmlPath}:`, readError);
                errorCount++; // Count read errors
            }
        } else {
            log('warn', `[ProjectScanner] Could not find expected HTML view for element ${componentInfo.name} at ${htmlPath}`);
        }
        // This promise now resolves after scheduling, not after completion of updateVirtualFile
    };

    // Process components with concurrency limit
    const executing: Promise<void>[] = [];
    for (const componentInfo of componentsToProcess) {
        // We still await the processComponent call, which includes the async file read
        // but the heavier updateVirtualFile work is deferred via setImmediate.
        const p = processComponent(componentInfo).then(() => {
            executing.splice(executing.indexOf(p), 1);
        });
        executing.push(p);
        updateTasks.push(p);

        if (executing.length >= MAX_CONCURRENT_UPDATES) {
            await Promise.race(executing);
        }
    }

    // Wait for all tasks (including file reads and scheduling) to complete
    await Promise.all(updateTasks);

    program = languageService.getProgram(); // Update program reference after virtual file update


    // <<< Update Log Message: Processing happens in background >>>
    log('info', `[ProjectScanner] Aurelia document population scheduled. Processed ${processedCount} element views initially. Skipped ${skippedAttributeCount} non-element components. Encountered ${errorCount} file read errors. Background processing started...`);
} 