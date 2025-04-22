import * as ts from 'typescript';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { log } from '../utils/logger';
import { fileExistsOnDisk } from '../utils/utilities';

// Type definition for the state/dependencies needed by the host
interface LanguageServiceHostDependencies {
    workspaceRoot: string;
    documents: TextDocuments<TextDocument>;
    virtualFiles: Map<string, { content: string; version: number }>;
    strictMode: boolean;
}

/**
 * Creates and configures the TypeScript Language Service and its host.
 */
export function createLanguageServiceInstance(
    dependencies: LanguageServiceHostDependencies
): ts.LanguageService {
    const { workspaceRoot, documents, virtualFiles, strictMode } = dependencies;

    let compilerOptions: ts.CompilerOptions = {
        strict: strictMode,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs, 
        esModuleInterop: true,
        allowJs: true,
        allowSyntheticDefaultImports: true,
        baseUrl: workspaceRoot,
        // experimentalDecorators: true, 
        // emitDecoratorMetadata: true,
    };

    const configFileName = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, "tsconfig.json");
    let projectFiles: string[] = []; 
  
    if (configFileName) {
        log('info', `[createLanguageServiceInstance] Found tsconfig.json at: ${configFileName}`);
        const configFile = ts.readConfigFile(configFileName, ts.sys.readFile);
        if (configFile.error) {
            log('error', `[createLanguageServiceInstance] Error reading tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
        } else {
            const projectDir = path.dirname(configFileName);
            const parsedConfig = ts.parseJsonConfigFileContent(
                configFile.config, 
                ts.sys, 
                projectDir, 
                compilerOptions, 
                configFileName
            );

            if (parsedConfig.errors.length > 0) {
                log('warn', `[createLanguageServiceInstance] Errors parsing tsconfig.json:`);
                parsedConfig.errors.forEach(error => {
                    log('warn', `  - ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
                });
            }
            compilerOptions = parsedConfig.options;
            projectFiles = parsedConfig.fileNames;
            log('info', `[createLanguageServiceInstance] Parsed tsconfig.json. Effective CompilerOptions: ${JSON.stringify(compilerOptions)}`);
            log('info', `[createLanguageServiceInstance] TS project includes ${projectFiles.length} files.`);
        }
    } else {
        log('info', `[createLanguageServiceInstance] No tsconfig.json found. Using default compiler options.`);
    }

    compilerOptions.allowJs = true;
  
    const cachedProjectFiles = [...projectFiles];

    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => {
            const fileUris = new Set<string>();
            documents.keys().forEach(uri => {
                if (uri.endsWith('.ts') && !uri.endsWith('.virtual.ts')) {
                    fileUris.add(uri);
                }
            });
            virtualFiles.forEach((_val, uri) => fileUris.add(uri));
            cachedProjectFiles.forEach(filePath => fileUris.add(URI.file(filePath).toString()));

            const uniqueFsPaths = Array.from(fileUris).map(uri => URI.parse(uri).fsPath);
            log('debug', `[Host.getScriptFileNames] (Using cached project files) Returning ${uniqueFsPaths.length} paths.`);
            return uniqueFsPaths;
        },
        getScriptVersion: (fileName) => {
            const fileUri = URI.file(fileName).toString(); 
            let version = '0'; 
            const openDoc = documents.get(fileUri);
            if (openDoc) {
                version = openDoc.version.toString();
            }
            const virtualFile = virtualFiles.get(fileUri);
            if (virtualFile) {
                version = virtualFile.version.toString();
            }
            return version;
        },
        getScriptKind: (fileName) => {
            if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) {
                return ts.ScriptKind.TS;
            }
            return ts.ScriptKind.Unknown;
        },
        getScriptSnapshot: (fileName) => {
            const fileUri = URI.file(fileName).toString();
            log('debug', `[Host.getScriptSnapshot] Requested for: ${fileName}`);
            const openDoc = documents.get(fileUri);
            if (openDoc) {
                log('debug', `  - Found in open documents.`);
                return ts.ScriptSnapshot.fromString(openDoc.getText());
            }
            const virtualFile = virtualFiles.get(fileUri);
            if (virtualFile) {
                log('debug', `  - Found in virtual files map.`);
                return ts.ScriptSnapshot.fromString(virtualFile.content);
            }
             if (projectFiles.includes(fileName) || fileExistsOnDisk(fileName)) {
                try {
                    const content = ts.sys.readFile(fileName);
                    if (content !== undefined) {
                        log('debug', `  - Read from disk.`);
                       return ts.ScriptSnapshot.fromString(content);
                    }
                 } catch (e) {
                  log('error', `[Host.getScriptSnapshot] Error reading ${fileName} from disk: ${e}`);
                 }
             }
            log('debug', `  - No snapshot found/created.`);
            return undefined;
        },
        getCurrentDirectory: () => {
            log('debug', `[Host.getCurrentDirectory] Returning: ${workspaceRoot}`);
            return workspaceRoot;
        },
        getCompilationSettings: () => {
            log('debug', `[Host.getCompilationSettings] Returning options.`);
            return compilerOptions;
        },
        getDefaultLibFileName: (options) => {
            const libPath = ts.getDefaultLibFilePath(options);
            log('debug', `[Host.getDefaultLibFileName] Returning: ${libPath}`);
            return libPath;
        },
        fileExists: (fileName) => {
            const fileUri = URI.file(fileName).toString();
            let exists = false;
            if (virtualFiles.has(fileUri)) {
                exists = true;
            } else if (documents.get(fileUri)) {
                exists = true;
            } else {
                exists = fileExistsOnDisk(fileName);
            }
            return exists;
        },
        readFile: (fileName, encoding) => {
             const fileUri = URI.file(fileName).toString();
             log('debug', `[Host.readFile] Requested for: ${fileName}`);
             const openDoc = documents.get(fileUri);
             if (openDoc) {
                log('debug', `  - Found in open documents.`);
                return openDoc.getText();
             }
             const virtualFile = virtualFiles.get(fileUri);
             if (virtualFile) {
                log('debug', `  - Found in virtual files map.`);
                return virtualFile.content;
             }
             const content = ts.sys.readFile(fileName, encoding);
             log('debug', `  - ${content !== undefined ? 'Read from disk' : 'Not found on disk'}.`);
             return content;
        },
        readDirectory: (path, extensions, exclude, include, depth) => {
            log('debug', `[Host.readDirectory] Path: ${path}`);
            return ts.sys.readDirectory(path, extensions, exclude, include, depth);
        },
        directoryExists: (directoryName) => {
            const exists = ts.sys.directoryExists(directoryName);
            return exists;
        },
        getDirectories: (directoryName) => {
            log('debug', `[Host.getDirectories] Path: ${directoryName}`);
            return ts.sys.getDirectories(directoryName);
        },
        resolveModuleNames: (moduleNames, containingFile, _reusedNames, _redirectedReference, options, containingSourceFile?) => {
            log('debug', `[Host.resolveModuleNames] Trying to resolve: [${moduleNames.join(', ')}] from ${containingFile}`);
            const resolvedModules: (ts.ResolvedModule | undefined)[] = [];
            const currentCompilerOptions = host.getCompilationSettings(); 
            
            for (const moduleName of moduleNames) {
                 const result = ts.resolveModuleName(moduleName, containingFile, currentCompilerOptions, host);
                 if (result.resolvedModule) {
                     resolvedModules.push(result.resolvedModule);
                 } else {
                     resolvedModules.push(undefined);
                 }
             }
             return resolvedModules;
         },
    };
    return ts.createLanguageService(host);
} 