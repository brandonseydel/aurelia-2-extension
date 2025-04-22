export const AURELIA_BINDING_SUFFIXES = [
    '.bind', '.trigger', '.call', '.delegate', '.capture', 
    '.ref', '.one-time', '.to-view', '.from-view', '.two-way'
];

export const AURELIA_TEMPLATE_CONTROLLERS = [
    'repeat.for', 'if', 'else', 'switch', 'case', 
    'default-case', 'with', 'portal', 'view', 'au-slot'
];

export const AURELIA_SPECIAL_ATTRIBUTES = [
    'view-model', 'ref', 'element.ref'
]; 

export let viewModelMembersCache: Map<string, { content: string | undefined; members: string[] }> = new Map();
