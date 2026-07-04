


export function normalizePhone(phone?: string) {
    if (!phone) return "";
    return phone.replace(/[^0-9+]/g, "").slice(0, 20);
}

export function getValueByPath(obj: any, path: string, pathAliasesByRoot?: Map<string, { aliasPath: string, actualPath: string }>): any {
    if (!path) return undefined;

    const parts = path.split('.');

    // Iterate through path parts
    for (let i = 0; i < parts.length; i++) {
        let part = parts[i];

        // Check if part has [] suffix for array mapping
        if (part.endsWith('[]')) {
            const arrayKey = part.slice(0, -2); // Remove [] from the end
            const array = obj[arrayKey];

            if (Array.isArray(array)) {
                // Get remaining path parts after this array part
                const remainingPath = parts.slice(i + 1).join('.');
                if (remainingPath) {
                    // Map each item through the remaining path
                    return array.map((item: any) => getValueByPath(item, remainingPath));
                } else {
                    // Just return the array itself if no remaining path
                    return array;
                }
            }
        } else {
            // Check if this part is an alias root
            const aliasConfig = pathAliasesByRoot?.get(part);
            if (aliasConfig) {
                const { aliasPath, actualPath } = aliasConfig;
                const aliasRoot = aliasPath.split('.')[0];
                const aliasRootWithoutBrackets = aliasRoot.endsWith('[]') ? aliasRoot.slice(0, -2) : aliasRoot;
                const array = obj[aliasRootWithoutBrackets];

                if (Array.isArray(array)) {
                    // Get sub-path after alias root from actual path
                    const actualRoot = actualPath.split('.')[0];

                    const actualSubPath = actualPath.substring(actualRoot.length + 1);
                    // Get remaining user path after the alias root part
                    const userSubPath = parts.slice(i + 1).join('.');
                    const fullActualPath = [actualSubPath, userSubPath].filter(Boolean).join('.');

                    return array.map((item: any) => getValueByPath(item, fullActualPath));
                }
            }

            // Check for array access with index like [0] or [-1]
            const arrayMatch = part.match(/^(\w+)\[(-?\d+)\]$/);
            if (arrayMatch) {
                const [, key, indexStr] = arrayMatch;
                const arr = obj[key];
                if (!Array.isArray(arr)) {
                    return undefined;
                }
                let index = Number(indexStr);
                if (index < 0) {
                    index = arr.length + index;
                }
                obj = arr[index];
                if (obj === undefined || obj === null) {
                    return undefined;
                }
                continue;
            }
        }

        // If not array or alias, proceed normally
        obj = obj[part];
        if (obj === undefined || obj === null) {
            return undefined;
        }
    }

    return obj;
}

export function getValueBySinglePath(obj: any, path: string): any {
    if (!path) return undefined;

    return path.split('.').reduce((acc, part) => {
        if (acc === undefined || acc === null) return undefined;

        // Handle array access like items[0] or items[-1]
        const arrayMatch = part.match(/^(\w+)\[(-?\d+)\]$/);
        if (arrayMatch) {
            const [, key, indexStr] = arrayMatch;
            const arr = acc[key];
            if (!Array.isArray(arr)) return undefined;
            let index = Number(indexStr);
            // Handle negative indices
            if (index < 0) {
                index = arr.length + index;
            }
            return arr[index];
        }

        return acc[part];
    }, obj);
}