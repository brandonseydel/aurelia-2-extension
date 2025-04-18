import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Enum defining different types of Aurelia expressions
 */
export enum AureliaExpressionType {
  DEFAULT = 'default',           // Standard interpolation: ${someValue}
  COMPLEX_BINDING = 'complex',   // More complex bindings: ${user.address.city}
  DELEGATE = 'delegate',         // Event handlers: click.delegate="doSomething()"
  TRIGGER = 'trigger',           // Event triggers: input.trigger="onChange($event)"
  BINDING = 'binding'            // Value binding: value.bind="someProperty"
}

/**
 * Interface for context information about Aurelia completions
 */
export interface AureliaCompletionContext {
  componentPath: string;         // Path to the component file
  viewModelClassName?: string;   // Name of the view model class
  bindables?: string[];          // Available bindable properties
  availableVariables?: Map<string, string>; // Variables available in scope and their types
}

/**
 * This class manages the TypeScript project and language service integration
 */
export class TypeScriptIntegration {
  private languageService: ts.LanguageService | null = null;
  private compilerOptions: ts.CompilerOptions;
  private projectRoot: string;
  private fileVersions: Map<string, number> = new Map();
  private virtualFiles: Map<string, string> = new Map();
  // Add caching to reduce file operations
  private cachedTsFiles: string[] | null = null;
  private cachedResults: Map<string, ts.CompletionEntry[]> = new Map();
  private diagnosticsCache = new Map<string, ts.Diagnostic[]>();
  private lastVirtualFile = '';
  program: ts.Program | null = null;
  typeChecker: ts.TypeChecker | null = null;

  constructor(projectRoot: string) {
    console.log(`Initializing TypeScriptIntegration with root: ${projectRoot}`);
    this.projectRoot = projectRoot;
    this.compilerOptions = {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      jsx: ts.JsxEmit.React,
      strict: false,
      strictNullChecks: false,
      strictPropertyInitialization: false,
      noImplicitAny: false,
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts']
    };

    this.initializeLanguageService();
  }

  /**
   * Initialize the TypeScript language service
   */
  private initializeLanguageService() {
    try {
      const tsFiles = this.getTypeScriptFiles();

      // Create a custom host that can provide file content
      const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => this.compilerOptions,
        getScriptFileNames: () => [...tsFiles, ...Array.from(this.virtualFiles.keys())],
        getScriptVersion: (fileName) => {
          // Virtual files have their own versioning
          if (this.virtualFiles.has(fileName)) {
            return `${this.fileVersions.get(fileName) || 1}`;
          }
          
          // For real files, use modification time
          try {
            const stats = fs.statSync(fileName);
            return `${stats.mtimeMs}`;
          } catch (error) {
            return '1';
          }
        },
        getScriptSnapshot: (fileName) => {
          // Handle virtual files first
          if (this.virtualFiles.has(fileName)) {
            const content = this.virtualFiles.get(fileName) || '';
            return ts.ScriptSnapshot.fromString(content);
          }
          
          // Then handle real files
          try {
            if (!fs.existsSync(fileName)) {
              return undefined;
            }
            
            const content = fs.readFileSync(fileName, 'utf8');
            return ts.ScriptSnapshot.fromString(content);
          } catch (error) {
            return undefined;
          }
        },
        getCurrentDirectory: () => this.projectRoot,
        getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
        fileExists: fileName => {
          // Check virtual files
          if (this.virtualFiles.has(fileName)) {
            return true;
          }
          
          // Then check real files
          return fs.existsSync(fileName);
        },
        readFile: fileName => {
          // Check virtual files
          if (this.virtualFiles.has(fileName)) {
            return this.virtualFiles.get(fileName) || '';
          }
          
          // Then check real files
          try {
            return fs.readFileSync(fileName, 'utf8');
          } catch (error) {
            return '';
          }
        },
        directoryExists: path => {
          try {
            return fs.statSync(path).isDirectory();
          } catch (error) {
            return false;
          }
        },
        getDirectories: path => {
          try {
            return fs.readdirSync(path).filter(item => {
              try {
                return fs.statSync(path + '/' + item).isDirectory();
              } catch (error) {
                return false;
              }
            });
          } catch (error) {
            return [];
          }
        }
      };

      // Create the language service
      this.languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
      console.log('TypeScript language service initialized');
      
      // Create program and type checker for deeper type analysis
      this.updateProgramAndTypeChecker();
    } catch (error) {
      console.error('Error initializing TypeScript language service:', error);
    }
  }
  
  /**
   * Update the TS program and type checker
   */
  private updateProgramAndTypeChecker() {
    if (!this.languageService) return;
    
    try {
      const program = this.languageService.getProgram();
      if (program) {
        this.program = program;
        this.typeChecker = program.getTypeChecker();
        console.log('TypeScript program and type checker initialized');
      } else {
        console.error('Failed to get TypeScript program');
        this.program = null;
        this.typeChecker = null;
      }
    } catch (error) {
      console.error('Error initializing TypeScript program:', error);
      this.program = null;
      this.typeChecker = null;
    }
  }

  /**
   * Get all TypeScript files in the project (with efficient filtering)
   */
  private getTypeScriptFiles(): string[] {
    // Use cached result if available
    if (this.cachedTsFiles) {
      return this.cachedTsFiles;
    }
    
    const files: string[] = [];
    const excludedDirs = new Set([
      'node_modules', '.git', 'dist', 'out', 'build', '.vscode',
      'test', 'tests', 'coverage', '.github', 'docs', 'examples'
    ]);
    const allowedExtensions = new Set(['.ts', '.tsx']);
    
    try {
      // Get tsconfig.json to respect project settings if available
      let tsconfigPath = path.join(this.projectRoot, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath)) {
        try {
          const tsconfigContent = fs.readFileSync(tsconfigPath, 'utf8');
          const tsconfig = JSON.parse(tsconfigContent);
          
          // Use include/exclude patterns from tsconfig
          if (tsconfig.include) {
            // Fast path: if tsconfig has specific includes, use those
            const includedFiles: string[] = [];
            for (const pattern of tsconfig.include) {
              // Simple glob implementation focusing on common patterns
              if (pattern.endsWith('/**/*.ts')) {
                const baseDir = path.join(this.projectRoot, pattern.replace('/**/*.ts', ''));
                if (fs.existsSync(baseDir)) {
                  this.fastCollectTsFiles(baseDir, includedFiles, excludedDirs, allowedExtensions);
                }
              } else if (pattern.endsWith('/**/*.tsx')) {
                const baseDir = path.join(this.projectRoot, pattern.replace('/**/*.tsx', ''));
                if (fs.existsSync(baseDir)) {
                  this.fastCollectTsFiles(baseDir, includedFiles, excludedDirs, allowedExtensions);
                }
              } else if (pattern.endsWith('/*.ts') || pattern.endsWith('/*.tsx')) {
                const baseDir = path.join(this.projectRoot, pattern.replace('/*.ts', '').replace('/*.tsx', ''));
                if (fs.existsSync(baseDir)) {
                  this.collectTsFilesInDir(baseDir, includedFiles, allowedExtensions);
                }
              }
            }
            
            // If we found files, use them and skip full scan
            if (includedFiles.length > 0) {
              this.cachedTsFiles = includedFiles;
              return includedFiles;
            }
          }
        } catch (e) {
          // If tsconfig parsing fails, fall back to directory scan
        }
      }
      
      // Limited scan - focus on most common project structures
      // Try src directory first as it's most common
      const srcDir = path.join(this.projectRoot, 'src');
      if (fs.existsSync(srcDir)) {
        this.fastCollectTsFiles(srcDir, files, excludedDirs, allowedExtensions);
      } else {
        // Fall back to scanning the root folder with depth limit
        this.fastCollectTsFiles(this.projectRoot, files, excludedDirs, allowedExtensions, 3);
      }
    } catch (error) {
      console.error('Error getting TypeScript files:', error);
    }
    
    // Cache the result
    this.cachedTsFiles = files;
    return files;
  }
  
  /**
   * Fast collection of TypeScript files with optimized directory traversal
   */
  private fastCollectTsFiles(
    dir: string, 
    files: string[], 
    excludedDirs: Set<string>,
    allowedExtensions: Set<string>,
    maxDepth: number = 10
  ): void {
    if (maxDepth <= 0) return;
    
    try {
      // Skip excluded directories efficiently
      const baseDirName = path.basename(dir);
      if (excludedDirs.has(baseDirName)) {
        return;
      }
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      // Process files first (faster than recursing into directories)
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          const ext = path.extname(entry.name);
          if (allowedExtensions.has(ext)) {
            files.push(path.join(dir, entry.name));
          }
        }
      }
      
      // Then process directories
      for (const entry of entries) {
        if (entry.isDirectory() && !excludedDirs.has(entry.name)) {
          this.fastCollectTsFiles(
            path.join(dir, entry.name),
            files,
            excludedDirs,
            allowedExtensions,
            maxDepth - 1
          );
        }
      }
    } catch (error) {
      // Silently ignore errors in directory traversal (e.g. permission issues)
    }
  }
  
  /**
   * Collect TypeScript files in a single directory (non-recursive)
   */
  private collectTsFilesInDir(
    dir: string,
    files: string[],
    allowedExtensions: Set<string>
  ): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          const ext = path.extname(entry.name);
          if (allowedExtensions.has(ext)) {
            files.push(path.join(dir, entry.name));
          }
        }
      }
    } catch (error) {
      // Silently ignore errors
    }
  }

  /**
   * Normalize file path for consistent handling
   */
  private normalizeFilePath(filePath: string): string {
    // Handle file:// URIs
    if (filePath.startsWith('file://')) {
      filePath = filePath.substring(filePath.startsWith('file:///') ? 8 : 7);
    }
    
    // Fix Windows paths
    if (process.platform === 'win32') {
      // Remove leading slash if present
      if (filePath.startsWith('/')) {
        filePath = filePath.substring(1);
      }
      // Replace forward slashes with backslashes
      filePath = filePath.replace(/\//g, '\\');
    }
    
    return filePath;
  }

  /**
   * Get completions for an expression in a TypeScript context
   * Simplified implementation that focuses on reliable results
   */
  public getCompletions(expression: string, fileName: string, position: number): ts.CompletionEntry[] {
    if (!this.languageService) {
      return [];
    }

    // Check cache first
    const cacheKey = `${fileName}:${expression}:${position}`;
    if (this.cachedResults.has(cacheKey)) {
      return this.cachedResults.get(cacheKey) || [];
    }

    const normalizedFileName = this.normalizeFilePath(fileName);
    
    try {
      // Find the correct TS file to use
      const tsFile = this.findMatchingTsFile(normalizedFileName);
      if (!tsFile) {
        return [];
      }
      
      // Create a simple virtual file for completions
      const virtualFileName = `${normalizedFileName}.completion.ts`;
      const virtualPosition = this.createSimpleVirtualFile(virtualFileName, tsFile, expression);
      
      // Get completions at position
      const completions = this.languageService.getCompletionsAtPosition(
        virtualFileName,
        virtualPosition,
        { includeCompletionsForModuleExports: true }
      );
      
      if (!completions || completions.entries.length === 0) {
        return [];
      }
      
      // Enhance entries with type information
      const enhancedEntries = completions.entries.map(entry => {
        const details = this.languageService?.getCompletionEntryDetails(
          virtualFileName,
          virtualPosition,
          entry.name,
          undefined,
          undefined,
          undefined,
          undefined
        );
        
        if (details) {
          // Store type information
          (entry as any).typeInfo = details.displayParts?.map(p => p.text).join('') || '';
          (entry as any).documentation = details.documentation?.map(d => d.text).join('') || '';
        }
        
        return entry;
      });
      
      // Cache the results
      this.cachedResults.set(cacheKey, enhancedEntries);
      
      return enhancedEntries;
    } catch (error) {
      return [];
    }
  }
  
  /**
   * Find matching TypeScript file for an HTML file
   */
  private findMatchingTsFile(fileName: string): string | null {
    // If it's already a TS file, return it
    if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) {
      return fs.existsSync(fileName) ? fileName : null;
    }
    
    // For HTML files, try to find matching TS file
    if (fileName.endsWith('.html')) {
      // Direct correspondence
      const tsFile = fileName.replace(/\.html$/, '.ts');
      if (fs.existsSync(tsFile)) {
        return tsFile;
      }
      
      // Try to find in common locations based on file name
      const baseName = path.basename(fileName, '.html');
      const possibleLocations = [
        path.join(this.projectRoot, `${baseName}.ts`),
        path.join(this.projectRoot, 'src', `${baseName}.ts`),
        path.join(this.projectRoot, 'src', 'components', `${baseName}.ts`),
        path.join(this.projectRoot, 'src', 'views', `${baseName}.ts`)
      ];
      
      for (const location of possibleLocations) {
        if (fs.existsSync(location)) {
          return location;
        }
      }
    }
    
    return null;
  }
  
  /**
   * Create a simple virtual file for handling completions efficiently
   */
  private createSimpleVirtualFile(virtualFileName: string, tsFileName: string, expression: string): number {
    try {
      // Read the source TS file
      const sourceContent = fs.readFileSync(tsFileName, 'utf8');
      
      // Extract class name from the source
      const classNameMatch = sourceContent.match(/export\s+class\s+(\w+)/);
      const className = classNameMatch ? classNameMatch[1] : 'ViewModel';
      
      // Create a simple wrapper that instantiates the class
      let virtualContent = `
// Original source
${sourceContent}

// Testing context
function getCompletions() {
  const vm = new ${className}();
  
  // Expression context
`;
      
      // Handle the expression - work with the last part if it contains dots
      const parts = expression.split('.');
      if (parts.length > 1) {
        const prefix = parts.slice(0, -1).join('.');
        virtualContent += `  vm.${prefix}.`;
      } else {
        virtualContent += `  vm.`;
      }
      
      virtualContent += `
}`;
      
      // Store the virtual file
      this.virtualFiles.set(virtualFileName, virtualContent);
      this.fileVersions.set(virtualFileName, 1);
      
      // Calculate position for completion
      const marker = parts.length > 1 ? 
        `vm.${parts.slice(0, -1).join('.')}.` : 
        `vm.`;
      const position = virtualContent.indexOf(marker) + marker.length;
      
      return position;
    } catch (error) {
      // Fallback to simple implementation
      const basicContent = `
class ViewModel {
  message: string = '';
  count: number = 0;
  items: any[] = [];
  isVisible: boolean = true;
}

const vm = new ViewModel();
vm.
`;
      
      this.virtualFiles.set(virtualFileName, basicContent);
      this.fileVersions.set(virtualFileName, 1);
      
      // Position right after 'vm.'
      return basicContent.indexOf('vm.') + 3;
    }
  }

  /**
   * Get type information for an expression
   */
  public getTypeInfo(expression: string, fileName: string): string | null {
    if (!this.languageService) {
      return null;
    }

    try {
      const normalizedFileName = this.normalizeFilePath(fileName);
      const tsFile = this.findMatchingTsFile(normalizedFileName);
      if (!tsFile) {
        return null;
      }
      
      // Create virtual file for type info
      const virtualFileName = `${normalizedFileName}.typeinfo.ts`;
      const virtualPosition = this.createSimpleVirtualFile(virtualFileName, tsFile, expression);
      
      // Get type info just before the completion position
      const quickInfo = this.languageService.getQuickInfoAtPosition(
        virtualFileName, 
        virtualPosition - 1
      );
      
      if (quickInfo && quickInfo.displayParts) {
        return quickInfo.displayParts.map(p => p.text).join('');
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Find definition for a symbol
   */
  public findDefinition(symbol: string, fileName: string) {
    if (!this.languageService) return null;
    
    try {
      const normalizedFileName = this.normalizeFilePath(fileName);
      const tsFile = this.findMatchingTsFile(normalizedFileName);
      if (!tsFile) {
        return null;
      }
      
      // Create a virtual file for definition lookup
      const virtualFileName = `${normalizedFileName}.definition.ts`;
      const virtualPosition = this.createSimpleVirtualFile(virtualFileName, tsFile, symbol);
      
      // Get definition
      const definitions = this.languageService.getDefinitionAtPosition(
        virtualFileName, 
        virtualPosition - 1
      );
      
      if (definitions && definitions.length > 0) {
        const def = definitions[0];
        return {
          fileName: def.fileName,
          line: this.getLineNumberFromPosition(def.fileName, def.textSpan.start),
          character: this.getCharacterFromPosition(def.fileName, def.textSpan.start)
        };
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Get line number from position in file
   */
  private getLineNumberFromPosition(fileName: string, position: number): number {
    try {
      const fileContent = this.program?.getSourceFile(fileName)?.text;
      if (!fileContent) return 0;
      
      const lines = fileContent.substring(0, position).split('\n');
      return lines.length - 1;
    } catch (error) {
      console.error(`Error getting line number: ${error}`);
      return 0;
    }
  }
  
  /**
   * Get character from position in file
   */
  private getCharacterFromPosition(fileName: string, position: number): number {
    try {
      const fileContent = this.program?.getSourceFile(fileName)?.text;
      if (!fileContent) return 0;
      
      const lines = fileContent.substring(0, position).split('\n');
      const lastLine = lines[lines.length - 1];
      return lastLine.length;
    } catch (error) {
      console.error(`Error getting character position: ${error}`);
      return 0;
    }
  }

  /**
   * Validate expression for errors
   */
  public validateExpression(expression: string, fileName: string) {
    if (!this.languageService) return [];

    try {
      const normalizedFileName = this.normalizeFilePath(fileName);
      const tsFile = this.findMatchingTsFile(normalizedFileName);
      if (!tsFile) {
        return [];
      }
      
      // Create a simple virtual file for validation
      const virtualFileName = `${normalizedFileName}.validate.ts`;
      const virtualContent = `
// Original source
${fs.readFileSync(tsFile, 'utf8')}

// Validate expression
function validateExpression() {
  const vm = new ViewModel();
  const result = ${expression};
}
`;
      
      this.virtualFiles.set(virtualFileName, virtualContent);
      this.fileVersions.set(virtualFileName, 1);
      
      // Get diagnostics
      const syntacticDiagnostics = this.languageService.getSyntacticDiagnostics(virtualFileName);
      const semanticDiagnostics = this.languageService.getSemanticDiagnostics(virtualFileName);
      
      const allDiagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];
      
      // Find the expression in the virtual file
      const expressionStart = virtualContent.indexOf(`const result = `) + `const result = `.length;
      const expressionEnd = expressionStart + expression.length;
      
      // Only return diagnostics that fall within the expression
      return allDiagnostics
        .filter(diag => {
          const start = diag.start || 0;
          return start >= expressionStart && start < expressionEnd;
        })
        .map(diag => {
          const start = (diag.start || 0) - expressionStart;
          const length = diag.length || 0;
          const message = typeof diag.messageText === 'string' 
            ? diag.messageText 
            : diag.messageText.messageText;
          
          return {
            message,
            start: Math.max(0, start),
            length: Math.min(length, expression.length)
          };
        });
    } catch (error) {
      return [];
    }
  }

  /**
   * Get completions for the given position in the virtual file
   */
  public getCompletionsAtPosition(
    documentPath: string,
    position: number,
    expression: string,
    context: AureliaCompletionContext,
    expressionType: AureliaExpressionType = AureliaExpressionType.DEFAULT
  ): ts.CompletionInfo | undefined {
    if (!this.languageService) {
      return;
    }

    // Skip processing for empty expressions
    if (!expression || expression.trim() === '') {
      return;
    }

    // Create or get virtual file
    const virtualFilePath = this.createVirtualFileWithContent(
      documentPath,
      position,
      expression,
      context,
      expressionType
    );
    
    if (!virtualFilePath) {
      return;
    }

    // Calculate the right position in the virtual file
    let virtualPosition = 0;
    if (expressionType === AureliaExpressionType.COMPLEX_BINDING) {
      virtualPosition = this.calculateVirtualPositionForComplexExpression(expression, position);
    } else {
      virtualPosition = this.calculateVirtualPosition(expression, position);
    }

    // Get completions from language service
    try {
      const completionInfo = this.languageService.getCompletionsAtPosition(
        virtualFilePath,
        virtualPosition,
        {
          includeCompletionsForModuleExports: true,
          includeCompletionsWithInsertText: true,
          includeCompletionsWithSnippetText: false,
          includeAutomaticOptionalChainCompletions: true,
          includeExternalModuleExports: true,
        }
      );

      return completionInfo;
    } catch (error) {
      console.error('Error getting completions:', error);
      return undefined;
    }
  }

  /**
   * Get diagnostics for the given expression
   */
  public getDiagnostics(
    documentPath: string,
    position: number,
    expression: string,
    context: AureliaCompletionContext,
    expressionType: AureliaExpressionType = AureliaExpressionType.DEFAULT
  ): ts.Diagnostic[] {
    if (!this.languageService) {
      return [];
    }

    // Skip empty expressions
    if (!expression || expression.trim() === '') {
      return [];
    }

    // Optimization: Skip very simple expressions that are unlikely to have errors
    // For example single identifiers or property access
    if (
      expressionType === AureliaExpressionType.DEFAULT && 
      /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/.test(expression.trim())
    ) {
      return [];
    }
    
    // Create or get virtual file
    const virtualFilePath = this.createVirtualFileWithContent(
      documentPath,
      position,
      expression,
      context,
      expressionType
    );
    
    if (!virtualFilePath) {
      return [];
    }

    // Get diagnostics from language service with caching
    const cacheKey = `${virtualFilePath}:${expression}`;
    if (this.diagnosticsCache.has(cacheKey)) {
      return this.diagnosticsCache.get(cacheKey) || [];
    }

    try {
      // Use getSyntacticDiagnostics for faster validation when possible
      let diagnostics: ts.Diagnostic[] = [];
      
      // For simple expressions, syntactic diagnostics are enough
      if (expressionType === AureliaExpressionType.DEFAULT) {
        diagnostics = this.languageService.getSyntacticDiagnostics(virtualFilePath);
        
        // Only do semantic analysis if there are no syntax errors
        if (diagnostics.length === 0 && expression.includes('.')) {
          diagnostics = this.languageService.getSemanticDiagnostics(virtualFilePath);
        }
      } else {
        // For complex bindings, we need both
        const syntacticDiagnostics = this.languageService.getSyntacticDiagnostics(virtualFilePath);
        const semanticDiagnostics = this.languageService.getSemanticDiagnostics(virtualFilePath);
        diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];
      }

      // Cache the result (with a limit on cache size)
      if (this.diagnosticsCache.size > 100) {
        // Clear the oldest entries if cache gets too large
        const keys = Array.from(this.diagnosticsCache.keys());
        for (let i = 0; i < 20; i++) {
          this.diagnosticsCache.delete(keys[i]);
        }
      }
      this.diagnosticsCache.set(cacheKey, diagnostics);
      
      return diagnostics;
    } catch (error) {
      console.error('Error getting diagnostics:', error);
      return [];
    }
  }

  /**
   * Create a virtual TypeScript file with the expression content for analysis
   */
  private createVirtualFileWithContent(
    documentPath: string,
    position: number,
    expression: string,
    context: AureliaCompletionContext,
    expressionType: AureliaExpressionType
  ): string | undefined {
    try {
      const normalizedFileName = this.normalizeFilePath(documentPath);
      const virtualFileName = `${normalizedFileName}.${expressionType}.ts`;
      
      // Try to find matching TS component file
      const tsFile = this.findMatchingTsFile(normalizedFileName);
      if (!tsFile) {
        return undefined;
      }
      
      // Read the source TS file
      const sourceContent = fs.readFileSync(tsFile, 'utf8');
      
      // Extract class name from the source
      const classNameMatch = sourceContent.match(/export\s+class\s+(\w+)/);
      const className = context.viewModelClassName || 
                        (classNameMatch ? classNameMatch[1] : 'ViewModel');
      
      // Create a virtual file with appropriate context for completion
      let virtualContent = `
// Original component code
${sourceContent}

// Virtual context for expression evaluation
function __getCompletions() {
  const vm = new ${className}();
`;

      // Add available variables from context
      if (context.availableVariables && context.availableVariables.size > 0) {
        context.availableVariables.forEach((type, name) => {
          virtualContent += `  const ${name}: ${type} = {} as any;\n`;
        });
      }
      
      // Add expression context based on expression type
      if (expressionType === AureliaExpressionType.COMPLEX_BINDING) {
        // For complex bindings, we need special handling
        virtualContent += `
  // Expression context
  const __result = ${expression};
}`;
      } else {
        // For simple interpolation
        virtualContent += `
  // Expression context
  const __result = vm.${expression};
}`;
      }
      
      // Store the virtual file
      this.virtualFiles.set(virtualFileName, virtualContent);
      this.fileVersions.set(virtualFileName, (this.fileVersions.get(virtualFileName) || 0) + 1);
      
      // Track the last created virtual file for position calculations
      this.lastVirtualFile = virtualFileName;
      
      return virtualFileName;
    } catch (error) {
      console.error('Error creating virtual file:', error);
      return undefined;
    }
  }

  /**
   * Calculate position in virtual file for completion
   */
  private calculateVirtualPosition(expression: string, originalPosition: number): number {
    try {
      // Find the virtual file marker position
      const marker = `  const __result = vm.`;
      // Find the position after the marker where the expression starts
      const startPosition = (this.virtualFiles.get(this.lastVirtualFile) || '').indexOf(marker) + marker.length;
      
      // Calculate relative position in the expression
      return startPosition + Math.min(originalPosition, expression.length);
    } catch (error) {
      // Fallback to end of expression
      const marker = `  const __result = vm.`;
      const startPosition = (this.virtualFiles.get(this.lastVirtualFile) || '').indexOf(marker) + marker.length;
      return startPosition + expression.length;
    }
  }

  /**
   * Calculate virtual position for complex expressions
   */
  private calculateVirtualPositionForComplexExpression(expression: string, originalPosition: number): number {
    try {
      // Find the virtual file marker position
      const marker = `  const __result = `;
      // Find the position after the marker where the expression starts
      const startPosition = (this.virtualFiles.get(this.lastVirtualFile) || '').indexOf(marker) + marker.length;
      
      // Calculate relative position in the expression
      return startPosition + Math.min(originalPosition, expression.length);
    } catch (error) {
      // Fallback to end of expression
      const marker = `  const __result = `;
      const startPosition = (this.virtualFiles.get(this.lastVirtualFile) || '').indexOf(marker) + marker.length;
      return startPosition + expression.length;
    }
  }

  private createVirtualFileWithContext(htmlPath: string, expression: string) {
    const tsFile = this.findMatchingTsFile(htmlPath);
    if (!tsFile) return null;

    const componentSource = fs.readFileSync(tsFile, 'utf8');
    const virtualPath = `${htmlPath}.${Date.now()}.ts`;
    
    const virtualContent = `
      ${componentSource}

      // Aurelia Expression Context
      function __aureliaContext() {
        // Component instance
        const $host = new ${this.getComponentClassName(componentSource)}();
        
        // Template context
        ${this.getTemplateContext(htmlPath)}
        
        // Expression being evaluated
        const $result = ${expression};
      }
    `;

    this.virtualFiles.set(virtualPath, virtualContent);
    return {
      path: virtualPath,
      exprPosition: virtualContent.indexOf('$result = ') + 10
    };
  }

  /**
   * Extract the component class name from source code
   */
  private getComponentClassName(source: string): string {
    // First try to find exported class
    const classMatch = source.match(/export\s+class\s+(\w+)/);
    if (classMatch) return classMatch[1];

    // Then look for default exported class
    const defaultClassMatch = source.match(/export\s+default\s+class\s+(\w+)/);
    if (defaultClassMatch) return defaultClassMatch[1];

    // Fallback to generic name
    return 'ViewModel';
  }

  /**
   * Generate template context code based on HTML file
   */
  private getTemplateContext(htmlPath: string): string {
    try {
      const htmlContent = fs.readFileSync(htmlPath, 'utf8');
      const elements = this.parseCustomElements(htmlContent);
      
      let contextCode = '';
      
      // Add context for custom elements
      elements.forEach(el => {
        contextCode += `const ${el} = {};\n`;
      });
      
      // Add common Aurelia template variables
      contextCode += `
const $event = {} as Event;
const $this = $host;
`;
      
      return contextCode;
    } catch {
      return `
const $event = {} as Event;
const $this = $host;
`;
    }
  }

  /**
   * Parse HTML to find custom elements
   */
  private parseCustomElements(html: string): string[] {
    const elements = new Set<string>();
    const elementRegex = /<([a-z]+-[a-z-]+)/gi;
    let match: RegExpExecArray | null;
    
    while ((match = elementRegex.exec(html)) !== null) {
      elements.add(match[1].replace(/-/g, ''));
    }
    
    return Array.from(elements);
  }
}                 