import * as ts from 'typescript';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { log } from '../utils/logger';
import { fileExistsOnDisk, toKebabCase } from '../utils/utilities';

// Type for the component map 
// (Consider moving to types.ts if used elsewhere)
type AureliaProjectComponentMap = Map<string, { uri: string, type: 'element' | 'attribute', name: string, bindables?: string[] }>;

/**
 * Helper: Get Bindable Properties from Class Node 
 */
function getBindablePropertiesFromClassNode(classNode: ts.ClassDeclaration, sourceFile: ts.SourceFile): string[] {
  const bindables: string[] = [];
  if (!classNode.members) return bindables;

  log('debug', `    - Checking for bindables in class: ${classNode.name?.getText(sourceFile)}`);
  classNode.members.forEach(member => {
    if (ts.isPropertyDeclaration(member) && member.name) {
      const decorators = ts.getDecorators(member);
      if (decorators && decorators.length > 0) {
        for (const decorator of decorators) {
          let decoratorName: string | undefined;
          const decoratorExpr = decorator.expression;
          if (ts.isCallExpression(decoratorExpr) && ts.isIdentifier(decoratorExpr.expression)) {
            decoratorName = decoratorExpr.expression.getText(sourceFile);
          } else if (ts.isIdentifier(decoratorExpr)) {
            decoratorName = decoratorExpr.getText(sourceFile);
          }
          if (decoratorName === 'bindable') {
            const propertyName = member.name.getText(sourceFile);
            log('debug', `      - Found @bindable property: ${propertyName}`);
            bindables.push(propertyName);
            break;
          }
        }
      }
    }
  });
  return bindables;
}

/**
 * Scans the workspace using the Language Service Program to find Aurelia components.
 * Modifies the provided components map.
 */
export function scanWorkspaceForAureliaComponents(
    languageService: ts.LanguageService,
    workspaceRoot: string, 
    aureliaProjectComponents: AureliaProjectComponentMap // Pass map to modify
): void {
    if (!languageService || !workspaceRoot) {
        log('warn', '[scanWorkspace] Language service or workspace root not available.');
        return;
    }
    log('info', `[scanWorkspace] Scanning project for Aurelia components/attributes...`);
    const foundComponents = new Map<string, { uri: string, type: 'element' | 'attribute', name: string, bindables?: string[] }>();
    const program = languageService.getProgram();
    if (!program) {
        log('warn', '[scanWorkspace] Could not get program from language service.');
        return;
    }

    const sourceFiles = program.getSourceFiles();
    log('info', `[scanWorkspace] Analyzing ${sourceFiles.length} source files...`);

    for (const sourceFile of sourceFiles) {
        const isDeclaration = sourceFile.isDeclarationFile;
        const normalizedFileName = sourceFile.fileName.replace(/\\/g, '/');
        const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, '/');
        const normalizedWorkspaceRootWithSlash = normalizedWorkspaceRoot.endsWith('/')
          ? normalizedWorkspaceRoot
          : normalizedWorkspaceRoot + '/';
        const isInWorkspace = normalizedFileName.startsWith(normalizedWorkspaceRootWithSlash);

        if (isDeclaration || !isInWorkspace) {
          // Log skipped files
          continue;
        }
        log('debug', `[scanWorkspace] Analyzing file: ${normalizedFileName}`);

        ts.forEachChild(sourceFile, node => {
            if (ts.isClassDeclaration(node) && node.name) {
                const className = node.name.getText(sourceFile);
                log('debug', `  - Found class: ${className}`);
                const decorators = ts.getDecorators(node);
                let isExplicitlyDecorated = false;

                if (decorators && decorators.length > 0) {
                    for (const decorator of decorators) {
                        const decoratorExpr = decorator.expression;
                        let decoratorName: string | undefined = undefined;
                        let firstArg: string | undefined = undefined;

                        if (ts.isCallExpression(decoratorExpr)) {
                            if (ts.isIdentifier(decoratorExpr.expression)) {
                                decoratorName = decoratorExpr.expression.getText(sourceFile);
                            }
                            if (decoratorExpr.arguments.length > 0 && ts.isStringLiteral(decoratorExpr.arguments[0])) {
                                firstArg = decoratorExpr.arguments[0].text;
                            }
                        } else if (ts.isIdentifier(decoratorExpr)) {
                            decoratorName = decoratorExpr.getText(sourceFile);
                        }
                        const fileUri = URI.file(sourceFile.fileName).toString();

                        if (decoratorName === 'customElement') {
                            isExplicitlyDecorated = true;
                            const elementName = firstArg ?? toKebabCase(className);
                            if (elementName && !foundComponents.has(elementName)) {
                                const bindables = getBindablePropertiesFromClassNode(node, sourceFile); 
                                foundComponents.set(elementName, { uri: fileUri, type: 'element', name: elementName, bindables: bindables });
                                log('info', `[scanWorkspace] --> Found Element: ${elementName} (Bindables: ${bindables.join(', ')}) in ${sourceFile.fileName}`);
                            }
                            break;
                        }
                        if (decoratorName === 'customAttribute') {
                            isExplicitlyDecorated = true;
                            const attributeName = firstArg ?? toKebabCase(className);
                             if (attributeName && !foundComponents.has(attributeName)) {
                                foundComponents.set(attributeName, { uri: fileUri, type: 'attribute', name: attributeName }); 
                                log('info', `[scanWorkspace] --> Found Attribute: ${attributeName} in ${sourceFile.fileName}`);
                             }
                             break;
                        }
                    }
                }

                if (!isExplicitlyDecorated) {
                    const tsFilePath = sourceFile.fileName;
                    const dirName = path.dirname(tsFilePath);
                    const baseName = path.basename(tsFilePath, ".ts");
                    const expectedHtmlFileName = `${toKebabCase(baseName)}.html`;
                    const expectedHtmlPath = path.join(dirName, expectedHtmlFileName);

                    if (fileExistsOnDisk(expectedHtmlPath)) {
                        const implicitElementName = toKebabCase(className);
                        if (implicitElementName && !foundComponents.has(implicitElementName)) {
                            const fileUri = URI.file(sourceFile.fileName).toString();
                            const bindables = getBindablePropertiesFromClassNode(node, sourceFile); 
                            foundComponents.set(implicitElementName, { uri: fileUri, type: 'element', name: implicitElementName, bindables: bindables });
                            log('info', `[scanWorkspace] --> Found Implicit Element: ${implicitElementName} (Bindables: ${bindables.join(', ')}) (via class ${className} + ${expectedHtmlFileName})`);
                        }
                    }
                }
            }
        });
    }
    // Clear the passed map and repopulate it
    aureliaProjectComponents.clear();
    foundComponents.forEach((value, key) => {
        aureliaProjectComponents.set(key, value);
    });
    log('info', `[scanWorkspace] Scan complete. Found ${aureliaProjectComponents.size} components/attributes.`);
}

/**
 * Updates the component map based on changes to a single TS file.
 * Modifies the provided components map.
 * Returns true if the map was potentially changed, false otherwise
 */
export function updateComponentInfoForFile(
    fileUri: string,
    languageService: ts.LanguageService, 
    workspaceRoot: string, 
    aureliaProjectComponents: AureliaProjectComponentMap // Pass map to modify
): boolean {
    if (!languageService || !workspaceRoot) return false;
    const program = languageService.getProgram();
    if (!program) return false;
    const sourceFile = program.getSourceFile(URI.parse(fileUri).fsPath);
    if (!sourceFile || sourceFile.isDeclarationFile || !sourceFile.fileName.startsWith(workspaceRoot)) {
        return false; // Not a relevant source file
    }

    let componentFound = false;
    let mapChanged = false;
    const filePath = URI.parse(fileUri).fsPath;

    // Check existing entries for this file URI to see if we need to remove old ones first
    let existingComponentName: string | undefined = undefined;
    for (const [name, info] of aureliaProjectComponents.entries()) {
        if (info.uri === fileUri) {
            existingComponentName = name;
            break;
        }
    }

    ts.forEachChild(sourceFile, node => {
        if (ts.isClassDeclaration(node) && node.name) {
            const className = node.name.getText(sourceFile);
            const decorators = ts.getDecorators(node);

            if (decorators && decorators.length > 0) {
                for (const decorator of decorators) {
                    const decoratorExpr = decorator.expression;
                    let decoratorName: string | undefined = undefined;
                    let firstArg: string | undefined = undefined;
                    if (ts.isCallExpression(decoratorExpr)) {
                        if (ts.isIdentifier(decoratorExpr.expression)) {
                            decoratorName = decoratorExpr.expression.getText(sourceFile);
                        }
                        if (decoratorExpr.arguments.length > 0 && ts.isStringLiteral(decoratorExpr.arguments[0])) {
                            firstArg = decoratorExpr.arguments[0].text;
                        }
                    } else if (ts.isIdentifier(decoratorExpr)) {
                        decoratorName = decoratorExpr.getText(sourceFile);
                    }

                    if (decoratorName === 'customElement') {
                        const elementName = firstArg ?? toKebabCase(className);
                        if (elementName) {
                             componentFound = true;
                             if (existingComponentName !== elementName || !aureliaProjectComponents.has(elementName)) {
                                if (existingComponentName) aureliaProjectComponents.delete(existingComponentName);
                                const bindables = getBindablePropertiesFromClassNode(node, sourceFile); 
                                aureliaProjectComponents.set(elementName, { uri: fileUri, type: 'element', name: elementName, bindables: bindables });
                                log('info', `[File Watch] Updated/Added Element: ${elementName} (Bindables: ${bindables.join(', ')}) from ${filePath}`);
                                mapChanged = true;
                             }
                        }
                        break;
                    }
                    if (decoratorName === 'customAttribute') {
                        const attributeName = firstArg ?? toKebabCase(className);
                         if (attributeName) {
                             componentFound = true;
                            if (existingComponentName !== attributeName || !aureliaProjectComponents.has(attributeName)) {
                                if (existingComponentName) aureliaProjectComponents.delete(existingComponentName);
                                aureliaProjectComponents.set(attributeName, { uri: fileUri, type: 'attribute', name: attributeName });
                                log('info', `[File Watch] Updated/Added Attribute: ${attributeName} from ${filePath}`);
                                mapChanged = true;
                            }
                         }
                         break;
                    }
                }
            }
        }
    });

    // If no component was found in the file, but we had an old entry, remove it
    if (!componentFound && existingComponentName) {
         aureliaProjectComponents.delete(existingComponentName);
         log('info', `[File Watch] Removed component/attribute ${existingComponentName} associated with ${filePath}`);
         mapChanged = true;
    }

    return mapChanged;
} 