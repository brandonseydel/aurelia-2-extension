import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { log } from '../utils/logger';
import { 
    fileExistsOnDisk} from '../utils/utilities';
// Import the shared types
import { AureliaProjectComponentMap, AureliaComponentInfo, AureliaBindableInfo } from '../common/types';

// Track component dependencies to manage updates when files change
interface ComponentDependencies {
    // Map of component URI to the components that depend on it
    dependsOn: Map<string, Set<string>>;
    // Map of component URI to the components it depends on
    dependedOnBy: Map<string, Set<string>>;
    // Map from file path to component URIs
    fileToComponents: Map<string, Set<string>>;
    // Track last scan timestamp
    lastFullScan: number;
    // Track status of in-progress scan
    scanInProgress: boolean;
}

// Initialize component dependency tracker
const componentDependencies: ComponentDependencies = {
    dependsOn: new Map(),
    dependedOnBy: new Map(),
    fileToComponents: new Map(),
    lastFullScan: 0,
    scanInProgress: false
};

const AURELIA_COMPONENT_DECORATORS = ['customElement', 'customAttribute', 'valueConverter', 'bindingBehavior'];

interface ScanResult {
    elements: AureliaComponentInfo[];
    attributes: AureliaComponentInfo[];
    // Add other component types as needed (value converters, binding behaviors)
}

/**
 * Extract bindable properties from a class declaration, 
 * including explicit attribute names from decorators.
 */
function getBindablePropertiesFromClassNode(
    classNode: ts.ClassDeclaration, 
    sourceFile: ts.SourceFile
): AureliaBindableInfo[] { // Return new structure
    const bindables: AureliaBindableInfo[] = [];
    
    try {
        // Get class members
        if (!classNode.members) {
            return bindables;
        }
        
        for (const member of classNode.members) {
            // Look for property declarations
            if (ts.isPropertyDeclaration(member) && member.name) {
                const propertyName = member.name.getText(sourceFile);
                let attributeName: string | undefined = undefined; // Variable to hold explicit attribute name
                
                // Check for @bindable decorator
                const decorators = ts.getDecorators(member);
                if (decorators && decorators.length > 0) {
                    for (const decorator of decorators) {
                        const decoratorExpr = decorator.expression;
                        let isBindableDecorator = false;

                        // Check if it's the bindable decorator (either @bindable or @bindable(...))
                        if (ts.isCallExpression(decoratorExpr) && ts.isIdentifier(decoratorExpr.expression)) {
                            isBindableDecorator = decoratorExpr.expression.getText(sourceFile) === 'bindable';
                        } else if (ts.isIdentifier(decoratorExpr)) {
                            isBindableDecorator = decoratorExpr.getText(sourceFile) === 'bindable';
                        }

                        if (isBindableDecorator) {
                             // It is a bindable decorator, now check arguments for explicit name
                            if (ts.isCallExpression(decoratorExpr) && decoratorExpr.arguments.length > 0) {
                                const firstArgument = decoratorExpr.arguments[0];
                                // Case 1: @bindable('my-attribute')
                                if (ts.isStringLiteral(firstArgument)) {
                                    attributeName = firstArgument.text;
                                }
                                // Case 2: @bindable({ attribute: 'my-attribute' })
                                else if (ts.isObjectLiteralExpression(firstArgument)) {
                                    for (const prop of firstArgument.properties) {
                                        if (
                                            ts.isPropertyAssignment(prop) && 
                                            ts.isIdentifier(prop.name) && 
                                            prop.name.text === 'attribute' && // Check for 'attribute' property
                                            ts.isStringLiteral(prop.initializer)
                                        ) {
                                            attributeName = prop.initializer.text;
                                            break; // Found the attribute property
                                        }
                                    }
                                }
                            }

                            // Add to results including the optional attribute name
                            bindables.push({ propertyName, attributeName });
                            break; // Found @bindable, move to next member
                        }
                    }
                }
            }
        }
        
        return bindables;
    } catch (e) {
        log('error', `[getBindablePropertiesFromClassNode] Error extracting bindables: ${e}`);
        return bindables; // Return empty on error
    }
}

/**
 * Convert a string from PascalCase to kebab-case
 */
export function toKebabCase(str: string): string {
    if (!str) return '';
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
              .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
              .toLowerCase();
}

/**
 * Find imported components referenced by a source file
 */
function findComponentDependencies(
    sourceFile: ts.SourceFile, 
    program: ts.Program
): string[] {
    const dependencies: string[] = [];
    const checker = program.getTypeChecker();
    
    // Track import declarations
    const importMap = new Map<string, string>();
    
    // Process import declarations
    function processImports() {
        ts.forEachChild(sourceFile, node => {
            if (ts.isImportDeclaration(node)) {
                // Get module specifier
                if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                    const modulePath = node.moduleSpecifier.text;
                    
                    // Process imports
                    if (node.importClause) {
                        // Handle default imports
                        if (node.importClause.name) {
                            const importName = node.importClause.name.text;
                            importMap.set(importName, modulePath);
                        }
                        
                        // Handle named imports
                        if (node.importClause.namedBindings) {
                            if (ts.isNamedImports(node.importClause.namedBindings)) {
                                node.importClause.namedBindings.elements.forEach(element => {
                                    const importName = element.name.text;
                                    importMap.set(importName, modulePath);
                                });
                            }
                        }
                    }
                }
            }
        });
    }
    
    // Find components used in the source file
    function findComponentReferences() {
        // Find component identifiers in JSX/TSX elements
        function visit(node: ts.Node) {
            if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
                // Get the tag name
                let tagName: string | undefined;
                
                if (ts.isJsxElement(node)) {
                    if (ts.isIdentifier(node.openingElement.tagName)) {
                        tagName = node.openingElement.tagName.text;
                    }
                } else if (ts.isJsxSelfClosingElement(node)) {
                    if (ts.isIdentifier(node.tagName)) {
                        tagName = node.tagName.text;
                    }
                }
                
                if (tagName && importMap.has(tagName)) {
                    dependencies.push(importMap.get(tagName)!);
                }
            }
            
            ts.forEachChild(node, visit);
        }
        
        visit(sourceFile);
    }
    
    try {
        processImports();
        findComponentReferences();
    } catch (e) {
        log('error', `[findComponentDependencies] Error: ${e}`);
    }
    
    return dependencies;
}

/**
 * Track dependency between components
 */
function registerComponentDependency(
    sourceUri: string,
    dependsOnUri: string
) {
    // Add to dependsOn map
    if (!componentDependencies.dependsOn.has(sourceUri)) {
        componentDependencies.dependsOn.set(sourceUri, new Set<string>());
    }
    componentDependencies.dependsOn.get(sourceUri)!.add(dependsOnUri);
    
    // Add to dependedOnBy map
    if (!componentDependencies.dependedOnBy.has(dependsOnUri)) {
        componentDependencies.dependedOnBy.set(dependsOnUri, new Set<string>());
    }
    componentDependencies.dependedOnBy.get(dependsOnUri)!.add(sourceUri);
}

/**
 * Register a component's file path
 */
function registerComponentFile(
    componentUri: string,
    filePath: string
) {
    if (!componentDependencies.fileToComponents.has(filePath)) {
        componentDependencies.fileToComponents.set(filePath, new Set<string>());
    }
    componentDependencies.fileToComponents.get(filePath)!.add(componentUri);
}

/**
 * Find components affected by changes to a file
 */
export function findAffectedComponents(filePath: string): string[] {
    const affected = new Set<string>();
    
    // Add direct components from this file
    const componentsInFile = componentDependencies.fileToComponents.get(filePath);
    if (componentsInFile) {
        componentsInFile.forEach(componentUri => {
            affected.add(componentUri);
            
            // Add components that depend on this component
            const dependents = componentDependencies.dependedOnBy.get(componentUri);
            if (dependents) {
                dependents.forEach(dependent => affected.add(dependent));
            }
        });
    }
    
    return Array.from(affected);
}

/**
 * Clear dependency data for a component
 */
function clearComponentDependencies(componentUri: string) {
    // Remove from dependsOn
    if (componentDependencies.dependsOn.has(componentUri)) {
        componentDependencies.dependsOn.delete(componentUri);
    }
    
    // Remove from dependedOnBy (more complex as we need to remove from other Sets)
    for (const [uri, dependents] of componentDependencies.dependedOnBy.entries()) {
        dependents.delete(componentUri);
    }
}

/**
 * Scan the entire workspace for Aurelia components and attributes.
 * Fills the provided component map with the results.
 */
export function scanWorkspaceForAureliaComponents(
    languageService: ts.LanguageService,
    workspaceRoot: string, 
    aureliaProjectComponents: AureliaProjectComponentMap
): void {
    // Don't scan if already in progress
    if (componentDependencies.scanInProgress) {
        log('info', `[scanWorkspace] Another scan is already in progress, skipping.`);
        return;
    }
    
    try {
        componentDependencies.scanInProgress = true;
        
        if (!languageService || !workspaceRoot) {
            log('warn', '[scanWorkspace] Language service or workspace root not available.');
            return;
        }
        log('info', `[scanWorkspace] Scanning project for Aurelia components/attributes...`);
        const foundComponents = new Map<string, AureliaComponentInfo>();
        const program = languageService.getProgram();
        if (!program) {
            log('warn', '[scanWorkspace] Could not get program from language service.');
            return;
        }

        const sourceFiles = program.getSourceFiles();
        log('info', `[scanWorkspace] Analyzing ${sourceFiles.length} source files...`);
        
        // Clear existing dependency data if this is a full scan
        componentDependencies.dependsOn.clear();
        componentDependencies.dependedOnBy.clear();
        componentDependencies.fileToComponents.clear();

        for (const sourceFile of sourceFiles) {
            const isDeclaration = sourceFile.isDeclarationFile;
            // Normalize paths before comparison
            const normalizedFileName = sourceFile.fileName.replace(/\\/g, '/');
            const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, '/');
            const normalizedWorkspaceRootWithSlash = normalizedWorkspaceRoot.endsWith('/')
              ? normalizedWorkspaceRoot
              : normalizedWorkspaceRoot + '/';
            const isInWorkspace = normalizedFileName.startsWith(normalizedWorkspaceRootWithSlash);

            if (isDeclaration || !isInWorkspace) {
              // Skip declaration files and files outside workspace
              continue;
            }
            
            const fileUri = URI.file(sourceFile.fileName).toString();
            
            log('debug', `[scanWorkspace] Analyzing file: ${normalizedFileName}`);

            ts.forEachChild(sourceFile, node => {
                if (ts.isClassDeclaration(node) && node.name) {
                    const className = node.name.getText(sourceFile);
                    if (!className) return;
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
                            } else if (ts.isIdentifier(decoratorExpr)) {
                                decoratorName = decoratorExpr.getText(sourceFile);
                            }

                            if (decoratorName === 'customElement') {
                                isExplicitlyDecorated = true;
                                let elementName: string | undefined;
                                if (ts.isCallExpression(decoratorExpr) && decoratorExpr.arguments.length > 0) {
                                    const firstArgument = decoratorExpr.arguments[0];
                                    if (ts.isStringLiteral(firstArgument)) {
                                        elementName = firstArgument.text;
                                    } else if (ts.isObjectLiteralExpression(firstArgument)) {
                                        for (const prop of firstArgument.properties) {
                                            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'name') {
                                                if (ts.isStringLiteral(prop.initializer)) {
                                                    elementName = prop.initializer.text;
                                                    break; // Found name property
                                                }
                                            }
                                        }
                                    }
                                }
                                // Fallback to kebab-case if name not found in decorator args
                                elementName = elementName ?? toKebabCase(className);

                                if (elementName && !foundComponents.has(elementName)) {
                                    const bindables = getBindablePropertiesFromClassNode(node, sourceFile);
                                    const componentInfo: AureliaComponentInfo = {
                                        uri: fileUri,
                                        type: 'element',
                                        name: elementName,
                                        bindables: bindables,
                                        className: className,
                                        sourceFile: sourceFile.fileName
                                    };
                                    foundComponents.set(elementName, componentInfo);

                                    // Register component file
                                    registerComponentFile(fileUri, sourceFile.fileName);

                                    // Update log to show property names
                                    const bindablePropNames = bindables.map(b => b.propertyName).join(', ');
                                    log('info', `[scanWorkspace] --> Found Element: ${elementName} (Bindables: ${bindablePropNames || 'None'}) in ${sourceFile.fileName}`);
                                }
                                break;
                            }
                            if (decoratorName === 'customAttribute') {
                                isExplicitlyDecorated = true;
                                let attributeName: string | undefined;
                                if (ts.isCallExpression(decoratorExpr) && decoratorExpr.arguments.length > 0) {
                                    const firstArgument = decoratorExpr.arguments[0];
                                    if (ts.isStringLiteral(firstArgument)) {
                                        attributeName = firstArgument.text;
                                    } else if (ts.isObjectLiteralExpression(firstArgument)) {
                                        for (const prop of firstArgument.properties) {
                                            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'name') {
                                                if (ts.isStringLiteral(prop.initializer)) {
                                                    attributeName = prop.initializer.text;
                                                    break; // Found name property
                                                }
                                            }
                                        }
                                    }
                                }
                                // Fallback to kebab-case if name not found in decorator args
                                attributeName = attributeName ?? toKebabCase(className);

                                 if (attributeName && !foundComponents.has(attributeName)) {
                                    const bindables = getBindablePropertiesFromClassNode(node, sourceFile);
                                    const componentInfo: AureliaComponentInfo = { 
                                        uri: fileUri, 
                                        type: 'attribute', 
                                        name: attributeName,
                                        bindables: bindables,
                                        className: className, 
                                        sourceFile: sourceFile.fileName 
                                    };
                                    foundComponents.set(attributeName, componentInfo);
                                    
                                    // Register component file
                                    registerComponentFile(fileUri, sourceFile.fileName);
                                    
                                    // Update log to show property names
                                    const bindablePropNames = bindables.map(b => b.propertyName).join(', ');
                                    log('info', `[scanWorkspace] --> Found Attribute: ${attributeName} (Bindables: ${bindablePropNames || 'None'}) in ${sourceFile.fileName}`);
                                 }
                                 break;
                            }
                            if (decoratorName === 'valueConverter') {
                                isExplicitlyDecorated = true;
                                let converterName: string | undefined;
                                if (ts.isCallExpression(decoratorExpr) && decoratorExpr.arguments.length > 0) {
                                    const firstArgument = decoratorExpr.arguments[0];
                                    if (ts.isStringLiteral(firstArgument)) {
                                        converterName = firstArgument.text;
                                    } 
                                }
                                // Fallback to convention: MyFormatValueConverter -> myFormat
                                if (!converterName && className.endsWith('ValueConverter')) {
                                     const baseName = className.substring(0, className.length - 'ValueConverter'.length);
                                     converterName = toKebabCase(baseName);
                                }

                                 if (converterName && !foundComponents.has(converterName)) {
                                    const componentInfo: AureliaComponentInfo = { 
                                        uri: fileUri, 
                                        type: 'valueConverter', 
                                        name: converterName,
                                        bindables: [], // Value converters don't have bindables
                                        className: className, 
                                        sourceFile: sourceFile.fileName 
                                    };
                                    foundComponents.set(converterName, componentInfo);
                                    registerComponentFile(fileUri, sourceFile.fileName); // Register file
                                    log('info', `[scanWorkspace] --> Found Value Converter: ${converterName} in ${sourceFile.fileName}`);
                                 }
                                 break; // Found the relevant Aurelia decorator
                            }
                        }
                    }

                    // <<< Check for implicit Value Converter by convention >>>
                    if (!isExplicitlyDecorated && className.endsWith('ValueConverter')) {
                        const baseName = className.substring(0, className.length - 'ValueConverter'.length);
                        const converterName = toKebabCase(baseName);
                        if (converterName && !foundComponents.has(converterName)) {
                             const componentInfo: AureliaComponentInfo = { 
                                uri: fileUri, 
                                type: 'valueConverter', 
                                name: converterName,
                                bindables: [], 
                                className: className, 
                                sourceFile: sourceFile.fileName 
                            };
                            foundComponents.set(converterName, componentInfo);
                            registerComponentFile(fileUri, sourceFile.fileName); // Register file
                            log('info', `[scanWorkspace] --> Found Implicit Value Converter: ${converterName} (from class ${className}) in ${sourceFile.fileName}`);
                        }
                    } 
                    // <<< Check for implicit Custom Element by convention >>>
                    else if (!isExplicitlyDecorated) { // Note: added 'else if' to avoid double-detecting if naming conflicts
                        const tsFilePath = sourceFile.fileName;
                        const dirName = path.dirname(tsFilePath);
                        const baseName = path.basename(tsFilePath, ".ts");
                        const expectedHtmlFileName = `${toKebabCase(baseName)}.html`;
                        const expectedHtmlPath = path.join(dirName, expectedHtmlFileName);

                        if (fileExistsOnDisk(expectedHtmlPath)) {
                            const implicitElementName = toKebabCase(className);
                            if (implicitElementName && !foundComponents.has(implicitElementName)) {
                                const bindables = getBindablePropertiesFromClassNode(node, sourceFile);
                                const componentInfo: AureliaComponentInfo = { 
                                    uri: fileUri, 
                                    type: 'element', 
                                    name: implicitElementName, 
                                    bindables: bindables,
                                    className: className, 
                                    sourceFile: sourceFile.fileName 
                                };
                                foundComponents.set(implicitElementName, componentInfo);
                                
                                // Register component files
                                registerComponentFile(fileUri, sourceFile.fileName);
                                registerComponentFile(fileUri, expectedHtmlPath);
                                
                                // Update log to show property names
                                const bindablePropNames = bindables.map(b => b.propertyName).join(', ');
                                log('info', `[scanWorkspace] --> Found Implicit Element: ${implicitElementName} (Bindables: ${bindablePropNames || 'None'}) (via class ${className} + ${expectedHtmlFileName})`);
                            }
                        }
                    }
                }
            });
            
            // Find component dependencies for this file
            const dependencies = findComponentDependencies(sourceFile, program);
            for (const dependencyPath of dependencies) {
                // Resolve the dependency path to get actual file path
                const resolvedModule = ts.resolveModuleName(
                    dependencyPath,
                    sourceFile.fileName,
                    program.getCompilerOptions(),
                    ts.sys
                );
                
                if (resolvedModule.resolvedModule) {
                    const dependencyFilePath = resolvedModule.resolvedModule.resolvedFileName;
                    const dependencyUri = URI.file(dependencyFilePath).toString();
                    
                    // Register dependency
                    registerComponentDependency(fileUri, dependencyUri);
                }
            }
        }
        
        // Clear the provided map and repopulate it
        aureliaProjectComponents.clear();
        foundComponents.forEach((value, key) => {
            aureliaProjectComponents.set(key, value);
        });
        
        // Update timestamp of last scan
        componentDependencies.lastFullScan = Date.now();
        
        log('info', `[scanWorkspace] Scan complete. Found ${aureliaProjectComponents.size} components/attributes.`);
        log('info', `[scanWorkspace] Component dependency tracking: ${componentDependencies.dependsOn.size} dependencies, ${componentDependencies.fileToComponents.size} files.`);
    } finally {
        componentDependencies.scanInProgress = false;
    }
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
    aureliaProjectComponents: AureliaProjectComponentMap
): boolean {
    if (!languageService || !workspaceRoot) return false;
    const program = languageService.getProgram();
    if (!program) return false;
    const filePath = URI.parse(fileUri).fsPath;
    const sourceFile = program.getSourceFile(filePath);

    // Normalize paths before comparison
    const normalizedFileName = sourceFile?.fileName.replace(/\\/g, '/');
    const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, '/');

    if (!sourceFile || sourceFile.isDeclarationFile || !normalizedFileName || !normalizedFileName.startsWith(normalizedWorkspaceRoot)) {
        return false; // Not a relevant source file
    }

    let componentFound = false;
    let mapChanged = false;

    // Check existing entries for this file URI to see if we need to remove old ones first
    const existingComponents = new Set<string>();
    aureliaProjectComponents.forEach((info, name) => {
        if (info.uri === fileUri) {
            existingComponents.add(name);
        }
    });
    
    // Clear dependency data for components from this file
    existingComponents.forEach(name => {
        const component = aureliaProjectComponents.get(name);
        if (component) {
            clearComponentDependencies(component.uri);
        }
    });
    
    // Remove file from component mapping
    componentDependencies.fileToComponents.delete(filePath);

    ts.forEachChild(sourceFile, node => {
        if (ts.isClassDeclaration(node) && node.name) {
            const className = node.name.getText(sourceFile);
            if (!className) return;
            log('debug', `  - Found class: ${className}`);
            const decorators = ts.getDecorators(node);
            let decoratedAsAureliaComponent = false;

            if (decorators && decorators.length > 0) {
                for (const decorator of decorators) {
                    const decoratorExpr = decorator.expression;
                    let decoratorName: string | undefined = undefined;
                    let firstArg: string | undefined = undefined;
                    if (ts.isCallExpression(decoratorExpr)) {
                        if (ts.isIdentifier(decoratorExpr.expression)) {
                            decoratorName = decoratorExpr.expression.getText(sourceFile);
                        }
                    } else if (ts.isIdentifier(decoratorExpr)) {
                        decoratorName = decoratorExpr.getText(sourceFile);
                    }

                    if (decoratorName === 'customElement') {
                        decoratedAsAureliaComponent = true;
                        let elementName: string | undefined;
                        if (ts.isCallExpression(decoratorExpr) && decoratorExpr.arguments.length > 0) {
                            const firstArgument = decoratorExpr.arguments[0];
                            if (ts.isStringLiteral(firstArgument)) {
                                elementName = firstArgument.text;
                            } else if (ts.isObjectLiteralExpression(firstArgument)) {
                                for (const prop of firstArgument.properties) {
                                    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'name') {
                                        if (ts.isStringLiteral(prop.initializer)) {
                                            elementName = prop.initializer.text;
                                            break; // Found name property
                                        }
                                    }
                                }
                            }
                        }
                         // Fallback to kebab-case if name not found in decorator args
                         elementName = elementName ?? toKebabCase(className);

                        if (elementName && !aureliaProjectComponents.has(elementName)) {
                            componentFound = true;
                            
                            // Track if name or component definition changed
                            const existingComponent = aureliaProjectComponents.get(elementName);
                            if (!existingComponent || existingComponent.uri !== fileUri) {
                                mapChanged = true;
                            }
                            
                            // Remove from existing
                            existingComponents.delete(elementName);
                            
                            // Add/update component
                            const bindables = getBindablePropertiesFromClassNode(node, sourceFile);
                            const componentInfo: AureliaComponentInfo = { 
                                uri: fileUri, 
                                type: 'element', 
                                name: elementName, 
                                bindables: bindables,
                                className: className, 
                                sourceFile: filePath 
                            };
                            aureliaProjectComponents.set(elementName, componentInfo);
                            
                            // Register component file
                            registerComponentFile(fileUri, filePath);
                            
                            // Update log
                            const bindablePropNames = bindables.map(b => b.propertyName).join(', ');
                            log('info', `[File Watch] Updated/Added Element: ${elementName} (Bindables: ${bindablePropNames || 'None'}) from ${filePath}`);
                        }
                        break;
                    }
                    if (decoratorName === 'customAttribute') {
                        decoratedAsAureliaComponent = true;
                        let attributeName: string | undefined;
                         if (ts.isCallExpression(decoratorExpr) && decoratorExpr.arguments.length > 0) {
                            const firstArgument = decoratorExpr.arguments[0];
                            if (ts.isStringLiteral(firstArgument)) {
                                attributeName = firstArgument.text;
                            } else if (ts.isObjectLiteralExpression(firstArgument)) {
                                for (const prop of firstArgument.properties) {
                                    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'name') {
                                        if (ts.isStringLiteral(prop.initializer)) {
                                            attributeName = prop.initializer.text;
                                            break; // Found name property
                                        }
                                    }
                                }
                            }
                         }
                         // Fallback to kebab-case if name not found in decorator args
                         attributeName = attributeName ?? toKebabCase(className);

                         if (attributeName && !aureliaProjectComponents.has(attributeName)) {
                             componentFound = true;
                             
                             // Track if name or component definition changed
                             const existingComponent = aureliaProjectComponents.get(attributeName);
                             if (!existingComponent || existingComponent.uri !== fileUri) {
                                 mapChanged = true;
                             }
                             
                             // Remove from existing
                             existingComponents.delete(attributeName);
                             
                             // Add/update component
                             const bindables = getBindablePropertiesFromClassNode(node, sourceFile);
                             const componentInfo: AureliaComponentInfo = { 
                                uri: fileUri, 
                                type: 'attribute', 
                                name: attributeName,
                                bindables: bindables,
                                className: className, 
                                sourceFile: filePath 
                             };
                             aureliaProjectComponents.set(attributeName, componentInfo);
                             
                             // Register component file
                             registerComponentFile(fileUri, filePath);
                             
                             // Update log
                             const bindablePropNames = bindables.map(b => b.propertyName).join(', ');
                             log('info', `[File Watch] Updated/Added Attribute: ${attributeName} (Bindables: ${bindablePropNames || 'None'}) from ${filePath}`);
                             
                             // Mark as changed
                             mapChanged = true;
                         }
                         break;
                    }
                    if (decoratorName === 'valueConverter') {
                         decoratedAsAureliaComponent = true;
                         let converterName: string | undefined;
                         if (ts.isCallExpression(decoratorExpr) && decoratorExpr.arguments.length > 0) {
                            const firstArgument = decoratorExpr.arguments[0];
                             if (ts.isStringLiteral(firstArgument)) {
                                 converterName = firstArgument.text;
                            } 
                         }
                         // Fallback to convention: MyFormatValueConverter -> myFormat
                         if (!converterName && className.endsWith('ValueConverter')) {
                              const baseName = className.substring(0, className.length - 'ValueConverter'.length);
                              converterName = toKebabCase(baseName);
                         }
 
                          if (converterName) { // Check if a name was determined
                             componentFound = true;
                             const existingComponent = aureliaProjectComponents.get(converterName);
                             if (!existingComponent || existingComponent.uri !== fileUri) {
                                mapChanged = true;
                            }
                            existingComponents.delete(converterName); // Remove from existing list for this file

                             const componentInfo: AureliaComponentInfo = { 
                                 uri: fileUri, 
                                 type: 'valueConverter', 
                                 name: converterName,
                                 bindables: [], // Keep as empty array
                                 className: className, 
                                 sourceFile: filePath 
                             };
                             aureliaProjectComponents.set(converterName, componentInfo);
                             registerComponentFile(fileUri, filePath); 
                             log('info', `[File Watch] Updated/Added Value Converter: ${converterName} from ${filePath}`);
                             mapChanged = true; // Ensure mapChanged is true if added/updated
                          }
                          break; // Found the relevant Aurelia decorator
                     }
                }
            }
             // <<< Add implicit Value Converter Check >>>
             if (!decoratedAsAureliaComponent && className.endsWith('ValueConverter')) {
                const baseName = className.substring(0, className.length - 'ValueConverter'.length);
                const converterName = toKebabCase(baseName);
                 if (converterName) {
                    componentFound = true;
                    const existingComponent = aureliaProjectComponents.get(converterName);
                    if (!existingComponent || existingComponent.uri !== fileUri) {
                        mapChanged = true;
                    }
                    existingComponents.delete(converterName); 
                    const componentInfo: AureliaComponentInfo = { 
                        uri: fileUri, type: 'valueConverter', name: converterName,
                        bindables: [], className: className, sourceFile: filePath // Keep bindables empty
                    };
                    aureliaProjectComponents.set(converterName, componentInfo);
                    registerComponentFile(fileUri, filePath); 
                    log('info', `[File Watch] Updated/Added Implicit Value Converter: ${converterName} from ${filePath}`);
                    mapChanged = true; 
                }
             } 
             // <<< Check for implicit elements only if not an implicit VC >>>
             else if (!decoratedAsAureliaComponent) { 
                const dirName = path.dirname(filePath);
                const baseName = path.basename(filePath, ".ts");
                const expectedHtmlFileName = `${toKebabCase(baseName)}.html`;
                const expectedHtmlPath = path.join(dirName, expectedHtmlFileName);

                if (fileExistsOnDisk(expectedHtmlPath)) {
                    const implicitElementName = toKebabCase(className);
                    if (implicitElementName) {
                        componentFound = true;
                        
                        // Track if name or component definition changed
                        const existingComponent = aureliaProjectComponents.get(implicitElementName);
                        if (!existingComponent || existingComponent.uri !== fileUri) {
                            mapChanged = true;
                        }
                        
                        // Remove from existing
                        existingComponents.delete(implicitElementName);
                        
                        // Add/update component
                        const bindables = getBindablePropertiesFromClassNode(node, sourceFile);
                        const componentInfo: AureliaComponentInfo = { 
                            uri: fileUri, 
                            type: 'element', 
                            name: implicitElementName, 
                            bindables: bindables,
                            className: className, 
                            sourceFile: filePath 
                        };
                        aureliaProjectComponents.set(implicitElementName, componentInfo);
                        
                        // Register component files
                        registerComponentFile(fileUri, filePath);
                        registerComponentFile(fileUri, expectedHtmlPath);
                        
                        // Update log
                        const bindablePropNames = bindables.map(b => b.propertyName).join(', ');
                        log('info', `[File Watch] Updated/Added Implicit Element: ${implicitElementName} (Bindables: ${bindablePropNames || 'None'}) (via class ${className} + ${expectedHtmlFileName})`);
                        
                        // Mark as changed
                        mapChanged = true;
                    }
                }
            }
        }
    });
    
    // Find component dependencies for this file
    const dependencies = findComponentDependencies(sourceFile, program);
    for (const dependencyPath of dependencies) {
        // Resolve the dependency path to get actual file path
        const resolvedModule = ts.resolveModuleName(
            dependencyPath,
            sourceFile.fileName,
            program.getCompilerOptions(),
            ts.sys
        );
        
        if (resolvedModule.resolvedModule) {
            const dependencyFilePath = resolvedModule.resolvedModule.resolvedFileName;
            const dependencyUri = URI.file(dependencyFilePath).toString();
            
            // Register dependency
            registerComponentDependency(fileUri, dependencyUri);
        }
    }

    // Remove any components that no longer exist in the file
    if (existingComponents.size > 0) {
        existingComponents.forEach(name => {
            aureliaProjectComponents.delete(name);
            mapChanged = true;
            log('info', `[File Watch] Removed component/attribute ${name} associated with ${filePath}`);
        });
    }

    return mapChanged;
}
