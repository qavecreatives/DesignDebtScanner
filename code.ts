type ScanCategory =
  | 'typography'
  | 'colors'
  | 'spacing'
  | 'components'
  | 'buttons'
  | 'radius'
  | 'dimensions'
  | 'naming'
  | 'styles'
  | 'variables'
  | 'accessibility';

type ScanOptions = {
  scope: 'page' | 'selection';
  categories: ScanCategory[];
};

type ColorOption = {
  hex: string;
  color: RGB;
  count: number;
};

type ComponentOption = {
  id: string;
  name: string;
};

type AccessibilityDetails = {
  layerType: string;
  textHex: string;
  backgroundHex: string;
  ratio: number;
  requiredRatio: number;
  textSizeLabel: string;
  suggestedHex?: string;
  suggestedRatio?: number;
};

type VariableCoverage = {
  localVariableCount: number;
  boundValues: number;
  tokenizableValues: number;
  percentage: number;
};

type FixAction =
  | {
      type: 'color';
      nodeIds: string[];
      sourceColor: RGB;
      targetColor: RGB;
      sourceHex: string;
      targetHex: string;
    }
  | {
      type: 'typography';
      nodeIds: string[];
      sourceSize: number;
      targetSize: number;
    }
  | {
      type: 'spacing';
      nodeIds: string[];
      kind: 'gap' | 'padding';
      sourceValue: number;
      targetValue: number;
    }
  | {
      type: 'radius';
      nodeIds: string[];
      sourceValue: number;
      targetValue: number;
    }
  | {
      type: 'button';
      nodeIds: string[];
      sourceHeight: number;
      targetHeight: number;
    }
  | {
      type: 'component';
      instanceIds: string[];
      canonicalId: string;
      duplicateIds: string[];
      mode: 'relink' | 'merge' | 'instance';
    }
  | {
      type: 'naming';
      nodeIds: string[];
      targetName: string;
    }
  | {
      type: 'dimensions';
      nodeIds: string[];
      targetWidth: number;
      targetHeight: number;
    }
  | {
      type: 'style';
      nodeIds: string[];
      styleId: string;
      styleName: string;
      styleKind: 'paint' | 'text';
      styleField: 'fill' | 'text';
    }
  | {
      type: 'variable';
      nodeIds: string[];
      variableId: string;
      variableName: string;
      variableField: 'fill' | 'stroke' | VariableBindableNodeField;
      bindings: Array<{ nodeId: string; paintIndex?: number; field?: VariableBindableNodeField }>;
    };

type ScanIssue = {
  id: string;
  category: ScanCategory;
  severity: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  nodeIds: string[];
  fix?: FixAction;
  colorOptions?: ColorOption[];
  componentOptions?: ComponentOption[];
  accessibilityDetails?: AccessibilityDetails;
};

type SpacingRecord = {
  value: number;
  nodeId: string;
  nodeName: string;
  kind: 'gap' | 'padding';
};

type ColorRecord = {
  color: RGB;
  nodeId: string;
  nodeName: string;
  type: 'fill' | 'stroke';
};

type TypographyRecord = {
  family: string;
  style: string;
  size: number;
  nodeId: string;
  nodeName: string;
};

type RadiusRecord = {
  value: number;
  nodeId: string;
  nodeName: string;
};

type ButtonRecord = {
  height: number;
  nodeId: string;
  nodeName: string;
};

figma.showUI(__html__, {
  width: 420,
  height: 700,
  themeColors: true,
});

figma.on('selectionchange', () => {
  figma.ui.postMessage({
    type: 'selection-changed',
    nodeIds: figma.currentPage.selection.map((node) => node.id),
  });
});

let scanCancelled = false;

function reportScanProgress(label: string): void {
  figma.ui.postMessage({ type: 'scan-progress', label });
}

async function yieldDuringScan(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (scanCancelled) throw new Error('__SCAN_CANCELLED__');
}

function getNodesToScan(scope: ScanOptions['scope']): readonly SceneNode[] {
  return scope === 'selection'
    ? figma.currentPage.selection
    : figma.currentPage.children;
}

function collectNodes(nodes: readonly SceneNode[]): SceneNode[] {
  const result: SceneNode[] = [];

  function walk(node: SceneNode): void {
    result.push(node);
    if ('children' in node) {
      for (const child of node.children) walk(child);
    }
  }

  for (const node of nodes) walk(node);
  return result;
}

function colorDistance(a: RGB, b: RGB): number {
  const r = a.r - b.r;
  const g = a.g - b.g;
  const blue = a.b - b.b;
  return Math.sqrt(r * r + g * g + blue * blue);
}

function colorToHex(color: RGB): string {
  const channel = (value: number): string =>
    Math.round(value * 255).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase();
}

function colorsMatch(a: RGB, b: RGB, threshold = 0.001): boolean {
  return colorDistance(a, b) <= threshold;
}

function collectColors(nodes: SceneNode[]): ColorRecord[] {
  const records: ColorRecord[] = [];

  for (const node of nodes) {
    if ('fills' in node && Array.isArray(node.fills)) {
      for (const paint of node.fills) {
        if (paint.type === 'SOLID' && paint.visible !== false) {
          records.push({ color: paint.color, nodeId: node.id, nodeName: node.name, type: 'fill' });
        }
      }
    }

    if ('strokes' in node && Array.isArray(node.strokes)) {
      for (const paint of node.strokes) {
        if (paint.type === 'SOLID' && paint.visible !== false) {
          records.push({ color: paint.color, nodeId: node.id, nodeName: node.name, type: 'stroke' });
        }
      }
    }
  }

  return records;
}

function scanColors(nodes: SceneNode[]): ScanIssue[] {
  const records = collectColors(nodes);
  const groups: { color: RGB; records: ColorRecord[] }[] = [];

  for (const record of records) {
    let group = groups.find((candidate) => colorsMatch(candidate.color, record.color));
    if (!group) {
      group = { color: record.color, records: [] };
      groups.push(group);
    }
    group.records.push(record);
  }

  const repeated = groups.filter((group) => group.records.length >= 2);
  const issues: ScanIssue[] = [];

  for (let i = 0; i < repeated.length; i += 1) {
    const groupA = repeated[i];
    for (let j = i + 1; j < repeated.length; j += 1) {
      const groupB = repeated[j];
      const distance = colorDistance(groupA.color, groupB.color);
      if (distance > 0.04) continue;

      const standard = groupA.records.length >= groupB.records.length ? groupA : groupB;
      const inconsistent = standard === groupA ? groupB : groupA;
      const sourceHex = colorToHex(inconsistent.color);
      const targetHex = colorToHex(standard.color);
      const nodeIds = [...new Set(inconsistent.records.map((record) => record.nodeId))];
      const id = `color-drift-${sourceHex}-${targetHex}`;

      if (issues.some((issue) => issue.id === id)) continue;
      issues.push({
        id,
        category: 'colors',
        severity: distance > 0.02 ? 'medium' : 'low',
        title: 'Near-duplicate colors',
        description:
          `${inconsistent.records.length} affected layer${inconsistent.records.length === 1 ? '' : 's'} use ${sourceHex}, ` +
          `while ${targetHex} appears ${standard.records.length} times.`,
        nodeIds,
        colorOptions: [
          { hex: sourceHex, color: inconsistent.color, count: inconsistent.records.length },
          { hex: targetHex, color: standard.color, count: standard.records.length },
        ],
        fix: {
          type: 'color',
          nodeIds,
          sourceColor: inconsistent.color,
          targetColor: standard.color,
          sourceHex,
          targetHex,
        },
      });
    }
  }

  return issues;
}

function collectSpacing(nodes: SceneNode[]): SpacingRecord[] {
  const records: SpacingRecord[] = [];
  for (const node of nodes) {
    if ('layoutMode' in node && node.layoutMode !== 'NONE' && 'itemSpacing' in node) {
      const value = node.itemSpacing;
      if (typeof value === 'number' && value >= 0) {
        records.push({ value: Math.round(value * 10) / 10, nodeId: node.id, nodeName: node.name, kind: 'gap' });
      }
    }
    if (
      'layoutMode' in node && node.layoutMode !== 'NONE' &&
      'paddingTop' in node && 'paddingRight' in node &&
      'paddingBottom' in node && 'paddingLeft' in node
    ) {
      for (const value of [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]) {
        if (typeof value === 'number' && value > 0) {
          records.push({ value: Math.round(value * 10) / 10, nodeId: node.id, nodeName: node.name, kind: 'padding' });
        }
      }
    }
  }
  return records;
}

function scanSpacing(nodes: SceneNode[]): ScanIssue[] {
  const records = collectSpacing(nodes);
  if (records.length === 0) return [];
  const issues: ScanIssue[] = [];

  for (const kind of ['gap', 'padding'] as const) {
    const kindRecords = records.filter((record) => record.kind === kind);
    if (kindRecords.length < 3) continue;

    const frequency = new Map<number, number>();
    for (const record of kindRecords) {
      frequency.set(record.value, (frequency.get(record.value) ?? 0) + 1);
    }

    const sorted = [...frequency.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const dominantValue = sorted[0][0];
    const dominantFrequency = sorted[0][1];
    const label = kind === 'gap' ? 'gaps' : 'padding';

    for (const [value, count] of sorted) {
      if (value === dominantValue || Math.abs(value - dominantValue) > 4) continue;
      const affected = kindRecords.filter((record) => record.value === value);
      const nodeIds = [...new Set(affected.map((record) => record.nodeId))];
      const difference = value - dominantValue;
      issues.push({
        id: `spacing-${kind}-drift-${value}-to-${dominantValue}`,
        category: 'spacing',
        severity: Math.abs(difference) >= 2 ? 'medium' : 'low',
        title: `${kind === 'gap' ? 'Gap' : 'Padding'} drift: ${value}px → ${dominantValue}px`,
        description: `${count} ${label} occurrence${count === 1 ? '' : 's'} use ${value}px while ${dominantValue}px is the dominant ${kind} value (${dominantFrequency} occurrences).`,
        nodeIds,
        fix: {
          type: 'spacing',
          nodeIds,
          kind,
          sourceValue: value,
          targetValue: dominantValue,
        },
      });
    }
  }
  return issues;
}

function collectTypography(nodes: SceneNode[]): TypographyRecord[] {
  const records: TypographyRecord[] = [];
  for (const node of nodes) {
    if (node.type !== 'TEXT' || typeof node.fontSize !== 'number') continue;
    if (node.fontName === figma.mixed) continue;
    const fontName = node.fontName as FontName;
    records.push({
      family: fontName.family,
      style: fontName.style,
      size: Math.round(node.fontSize * 10) / 10,
      nodeId: node.id,
      nodeName: node.name,
    });
  }
  return records;
}

function scanTypography(nodes: SceneNode[]): ScanIssue[] {
  const records = collectTypography(nodes);
  const groups = new Map<string, TypographyRecord[]>();
  for (const record of records) {
    const key = `${record.family}\u0000${record.style}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const issues: ScanIssue[] = [];
  for (const [key, group] of groups) {
    if (group.length < 3) continue;
    const counts = new Map<number, number>();
    for (const record of group) counts.set(record.size, (counts.get(record.size) ?? 0) + 1);
    const sizes = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const dominantSize = sizes[0][0];
    const dominantCount = sizes[0][1];
    const family = group[0].family;
    const style = group[0].style;

    for (const [size, count] of sizes) {
      if (size === dominantSize || Math.abs(size - dominantSize) > 4) continue;
      const affected = group.filter((record) => record.size === size);
      if (affected.length === 0) continue;
      const nodeIds = affected.map((record) => record.nodeId);
      const safeKey = key.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      issues.push({
        id: `typography-drift-${safeKey}-${size}-to-${dominantSize}`,
        category: 'typography',
        severity: Math.abs(size - dominantSize) >= 2 ? 'medium' : 'low',
        title: `Typography drift: ${size}px → ${dominantSize}px`,
        description:
          `${affected.length} text layer${affected.length === 1 ? '' : 's'} use ${size}px ` +
          `in ${family} ${style}, while ${dominantSize}px appears ${dominantCount} times.`,
        nodeIds,
        fix: { type: 'typography', nodeIds, sourceSize: size, targetSize: dominantSize },
      });
    }
  }
  return issues;
}

function collectRadii(nodes: SceneNode[]): RadiusRecord[] {
  const records: RadiusRecord[] = [];
  for (const node of nodes) {
    if (!('cornerRadius' in node) || typeof node.cornerRadius !== 'number') continue;
    if (node.cornerRadius < 0) continue;
    records.push({
      value: Math.round(node.cornerRadius * 10) / 10,
      nodeId: node.id,
      nodeName: node.name,
    });
  }
  return records;
}

function scanRadii(nodes: SceneNode[]): ScanIssue[] {
  const records = collectRadii(nodes);
  if (records.length < 3) return [];

  const frequency = new Map<number, number>();
  for (const record of records) {
    frequency.set(record.value, (frequency.get(record.value) ?? 0) + 1);
  }

  const sorted = [...frequency.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const dominantValue = sorted[0][0];
  const dominantFrequency = sorted[0][1];
  const issues: ScanIssue[] = [];

  for (const [value, count] of sorted) {
    if (value === dominantValue || Math.abs(value - dominantValue) > 2) continue;
    const affected = records.filter((record) => record.value === value);
    const nodeIds = [...new Set(affected.map((record) => record.nodeId))];
    issues.push({
      id: `radius-drift-${value}-to-${dominantValue}`,
      category: 'radius',
      severity: Math.abs(value - dominantValue) >= 2 ? 'medium' : 'low',
      title: `Radius drift: ${value}px → ${dominantValue}px`,
      description: `${count} affected layer${count === 1 ? '' : 's'} use a ${value}px corner radius while ${dominantValue}px is the dominant radius (${dominantFrequency} occurrences).`,
      nodeIds,
      fix: {
        type: 'radius',
        nodeIds,
        sourceValue: value,
        targetValue: dominantValue,
      },
    });
  }

  return issues;
}

function scanButtons(nodes: SceneNode[]): ScanIssue[] {
  const records: ButtonRecord[] = [];
  for (const node of nodes) {
    if (!('height' in node) || !('width' in node)) continue;
    if (!/(button|btn|cta)/i.test(node.name)) continue;
    records.push({
      height: Math.round(node.height * 10) / 10,
      nodeId: node.id,
      nodeName: node.name,
    });
  }
  if (records.length < 2) return [];

  const frequency = new Map<number, number>();
  for (const record of records) frequency.set(record.height, (frequency.get(record.height) ?? 0) + 1);
  const sorted = [...frequency.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const dominantHeight = sorted[0][0];
  const dominantFrequency = sorted[0][1];
  const issues: ScanIssue[] = [];

  for (const [height, count] of sorted) {
    if (height === dominantHeight || Math.abs(height - dominantHeight) > 8) continue;
    const affected = records.filter((record) => record.height === height);
    issues.push({
      id: `button-height-drift-${height}-to-${dominantHeight}`,
      category: 'buttons',
      severity: Math.abs(height - dominantHeight) >= 4 ? 'medium' : 'low',
      title: `Button height drift: ${height}px → ${dominantHeight}px`,
      description: `${count} button-like layer${count === 1 ? '' : 's'} use ${height}px while ${dominantHeight}px is the dominant button height (${dominantFrequency} occurrences).`,
      nodeIds: [...new Set(affected.map((record) => record.nodeId))],
      fix: {
        type: 'button',
        nodeIds: [...new Set(affected.map((record) => record.nodeId))],
        sourceHeight: height,
        targetHeight: dominantHeight,
      },
    });
  }
  return issues;
}

async function scanComponents(nodes: SceneNode[]): Promise<ScanIssue[]> {
  const components = nodes.filter((node) => node.type === 'COMPONENT');
  const groups = new Map<string, SceneNode[]>();
  for (const node of components) {
    const signature = componentSignature(node as ComponentNode);
    const groupKey = `${node.name}\u0000${signature}`;
    const group = groups.get(groupKey) ?? [];
    group.push(node);
    groups.set(groupKey, group);
  }

  const issues: ScanIssue[] = [];
  for (const [groupKey, matchingNodes] of groups) {
    if (matchingNodes.length < 2) continue;
    const name = groupKey.split('\u0000')[0];
    const duplicateIds = matchingNodes.map((node) => node.id);
    const instanceIds = (await Promise.all(
      nodes
        .filter((node): node is InstanceNode => node.type === 'INSTANCE')
        .map(async (node) => {
          const mainComponent = await node.getMainComponentAsync();
          return mainComponent && duplicateIds.includes(mainComponent.id)
            ? node.id
            : null;
        }),
    )).filter((nodeId): nodeId is string => nodeId !== null);
    issues.push({
      id: `duplicate-components-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      category: 'components',
      severity: 'low',
      title: `Duplicate component definitions: ${name}`,
      description: `${matchingNodes.length} components share the same name. Review whether they should be one component or intentional variants.`,
      nodeIds: matchingNodes.map((node) => node.id),
      componentOptions: matchingNodes.map((node) => ({ id: node.id, name: node.name })),
      fix: {
        type: 'component',
        instanceIds,
        canonicalId: matchingNodes[0].id,
        duplicateIds,
        mode: 'relink',
      },
    });
  }
  return issues;
}

function componentSignature(node: ComponentNode): string {
  function signatureFor(child: SceneNode): string {
    const dimensions = 'width' in child && 'height' in child
      ? `${Math.round(child.width * 10) / 10}x${Math.round(child.height * 10) / 10}`
      : '';
    const children = 'children' in child
      ? child.children.map((nested) => signatureFor(nested)).join(',')
      : '';
    return `${child.type}:${child.name}:${dimensions}[${children}]`;
  }
  return signatureFor(node);
}

function scanNaming(nodes: SceneNode[]): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const genericNamePattern = /^(component|instance|section)\s+\d+$/i;
  const genericNodes = nodes.filter((node) => genericNamePattern.test(node.name.trim()));

  if (genericNodes.length > 0) {
    issues.push({
      id: 'naming-generic-layers',
      category: 'naming',
      severity: 'low',
      title: 'Generic layer names',
      description: `${genericNodes.length} layer${genericNodes.length === 1 ? '' : 's'} use${genericNodes.length === 1 ? 's' : ''} generic component, instance, or section names. Shape, group, and frame names are ignored.`,
      nodeIds: genericNodes.map((node) => node.id),
    });
  }

  const namesByParent = new Map<string, Map<string, SceneNode[]>>();
  for (const node of nodes) {
    if (node.type === 'TEXT' || node.type === 'GROUP' || node.type === 'VECTOR') continue;
    const parentId = node.parent?.id ?? 'root';
    const names = namesByParent.get(parentId) ?? new Map<string, SceneNode[]>();
    const matching = names.get(node.name.trim()) ?? [];
    matching.push(node);
    names.set(node.name.trim(), matching);
    namesByParent.set(parentId, names);
  }

  for (const names of namesByParent.values()) {
    for (const [name, matchingNodes] of names) {
      if (!name || matchingNodes.length < 2 || genericNamePattern.test(name)) continue;
      issues.push({
        id: `naming-duplicate-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        category: 'naming',
        severity: 'low',
        title: `Duplicate layer name: ${name}`,
        description: `${matchingNodes.length} sibling layers share the name “${name}”.`,
        nodeIds: matchingNodes.map((node) => node.id),
        fix: {
          type: 'naming',
          nodeIds: matchingNodes.map((node) => node.id),
          targetName: name,
        },
      });
    }
  }

  return issues;
}

function getSolidFill(node: SceneNode | PageNode): RGB | null {
  if (!('fills' in node) || !Array.isArray(node.fills)) return null;
  const paint = node.fills.find((candidate) => candidate.type === 'SOLID' && candidate.visible !== false);
  return paint && paint.type === 'SOLID' ? paint.color : null;
}

function humanLayerType(node: SceneNode): string {
  switch (node.type) {
    case 'TEXT': return 'text layer';
    case 'VECTOR': return 'vector layer';
    case 'GROUP': return 'group layer';
    case 'COMPONENT': return 'component';
    case 'INSTANCE': return 'component instance';
    case 'FRAME': return 'frame layer';
    case 'SECTION': return 'section';
    case 'RECTANGLE': return 'rectangle layer';
    case 'ELLIPSE': return 'ellipse layer';
    case 'LINE': return 'line layer';
    default: return 'layer';
  }
}

function relativeLuminance(color: RGB): number {
  const channel = (value: number): number => {
    const normalized = value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    return normalized;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(foreground: RGB, background: RGB): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function scanAccessibility(nodes: SceneNode[]): ScanIssue[] {
  const issues: ScanIssue[] = [];

  for (const node of nodes) {
    if (node.type !== 'TEXT' || !Array.isArray(node.fills)) continue;
    const textColor = getSolidFill(node);
    if (!textColor) continue;

    let ancestor = node.parent;
    let background: RGB | null = null;
    while (ancestor && ancestor.type !== 'PAGE' && ancestor.type !== 'DOCUMENT') {
      background = getSolidFill(ancestor as SceneNode);
      if (background) break;
      ancestor = ancestor.parent;
    }
    if (!background) continue;

    const ratio = Math.round(contrastRatio(textColor, background) * 100) / 100;
    const fontSize = typeof node.fontSize === 'number' ? node.fontSize : 16;
    const fontName = node.fontName !== figma.mixed ? node.fontName as FontName : null;
    const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontName?.style.toLowerCase().includes('bold') === true);
    const requiredRatio = isLargeText ? 3 : 4.5;
    if (ratio >= requiredRatio) continue;

    const textHex = colorToHex(textColor);
    const backgroundHex = colorToHex(background);
    const blackRatio = Math.round(contrastRatio({ r: 0, g: 0, b: 0 }, background) * 100) / 100;
    const whiteRatio = Math.round(contrastRatio({ r: 1, g: 1, b: 1 }, background) * 100) / 100;
    const suggestions = [
      { hex: '#000000', ratio: blackRatio },
      { hex: '#FFFFFF', ratio: whiteRatio },
    ].filter((suggestion) => suggestion.ratio >= requiredRatio);
    const bestSuggestion = [...suggestions].sort((a, b) => b.ratio - a.ratio)[0];
    const suggestionText = bestSuggestion
      ? `Try text ${bestSuggestion.hex} (${bestSuggestion.ratio}:1 contrast), then paste that hex into Figma’s color picker.`
      : 'Choose a significantly darker or lighter text color in Figma’s color picker.';

    issues.push({
      id: `accessibility-contrast-${node.id}`,
      category: 'accessibility',
      severity: ratio < requiredRatio - 1 ? 'high' : 'medium',
      title: 'Insufficient text contrast',
      description: `${humanLayerType(node)} uses text ${textHex} on background ${backgroundHex}: ${ratio}:1 contrast. WCAG AA requires at least ${requiredRatio}:1 for ${isLargeText ? 'large' : 'normal'} text. ${suggestionText}`,
      nodeIds: [node.id],
      accessibilityDetails: {
        layerType: humanLayerType(node),
        textHex,
        backgroundHex,
        ratio,
        requiredRatio,
        textSizeLabel: isLargeText ? 'large' : 'normal',
        suggestedHex: bestSuggestion?.hex,
        suggestedRatio: bestSuggestion?.ratio,
      },
    });
  }

  return issues;
}

function dimensionLayerType(node: SceneNode): string {
  switch (node.type) {
    case 'COMPONENT': return 'component';
    case 'INSTANCE': return 'component instance';
    case 'FRAME': return 'frame';
    case 'SECTION': return 'section';
    case 'GROUP': return 'group';
    case 'RECTANGLE': return 'rectangle';
    default: return `${node.type.toLowerCase()} layer`;
  }
}

function scanDimensions(nodes: SceneNode[]): ScanIssue[] {
  const byType = new Map<string, SceneNode[]>();
  for (const node of nodes) {
    if (!('width' in node) || !('height' in node)) continue;
    const type = dimensionLayerType(node);
    const group = byType.get(type) ?? [];
    group.push(node);
    byType.set(type, group);
  }

  const issues: ScanIssue[] = [];
  for (const [layerType, typeNodes] of byType) {
    const dimensions = new Map<string, SceneNode[]>();
    for (const node of typeNodes) {
      const width = Math.round(node.width * 10) / 10;
      const height = Math.round(node.height * 10) / 10;
      const key = `${width}×${height}`;
      const matching = dimensions.get(key) ?? [];
      matching.push(node);
      dimensions.set(key, matching);
    }

    const sorted = [...dimensions.entries()].sort((a, b) => b[1].length - a[1].length);
    const dominant = sorted[0];
    if (!dominant || dominant[1].length < 3) continue;
    const [dominantWidth, dominantHeight] = dominant[0].split('×').map(Number);

    for (const [dimension, matchingNodes] of sorted) {
      if (dimension === dominant[0] || matchingNodes.length < 2) continue;
      const [width, height] = dimension.split('×').map(Number);
      const nearDominant = Math.abs(width - dominantWidth) <= 8 && Math.abs(height - dominantHeight) <= 8;
      if (nearDominant) {
        const affectedNodeIds = matchingNodes.map((node) => node.id);
        const safeNodeIds = matchingNodes.filter(isSafeDimensionNode).map((node) => node.id);
        issues.push({
          id: `dimensions-drift-${layerType}-${dimension}-to-${dominant[0]}`,
          category: 'dimensions',
          severity: Math.max(Math.abs(width - dominantWidth), Math.abs(height - dominantHeight)) >= 4 ? 'medium' : 'low',
          title: `${layerType[0].toUpperCase() + layerType.slice(1)} dimension drift: ${dimension} → ${dominant[0]}`,
          description: `${matchingNodes.length} affected ${layerType}${matchingNodes.length === 1 ? '' : 's'} use ${dimension}, while ${dominant[0]} is the dominant ${layerType} size (${dominant[1].length} occurrences).${safeNodeIds.length < matchingNodes.length ? ` ${matchingNodes.length - safeNodeIds.length} layer${matchingNodes.length - safeNodeIds.length === 1 ? '' : 's'} require manual review.` : ''}`,
          nodeIds: affectedNodeIds,
          fix: safeNodeIds.length > 0
            ? {
                type: 'dimensions',
                nodeIds: safeNodeIds,
                targetWidth: dominantWidth,
                targetHeight: dominantHeight,
              }
            : undefined,
        });
      }
    }

    if (!issues.some((issue) => issue.id.includes(`dimensions-drift-${layerType}-`))) {
      issues.push({
        id: `dimensions-${layerType}-${dominant[0]}`,
        category: 'dimensions',
        severity: 'low',
        title: `Repeated ${layerType} dimensions: ${dominant[0]}`,
        description: `${dominant[1].length} affected ${layerType}${dominant[1].length === 1 ? '' : 's'} share these dimensions.`,
        nodeIds: dominant[1].map((node) => node.id),
      });
    }
  }
  return issues;
}

function isSafeDimensionNode(node: SceneNode): boolean {
  if (!('resize' in node) || !('width' in node) || !('height' in node)) return false;
  if (node.type === 'COMPONENT' || node.type === 'INSTANCE') return false;
  if (isLayoutManagedDimension(node)) return false;
  if (node.type === 'TEXT') return node.textAutoResize === 'NONE';
  return ['FRAME', 'SECTION', 'RECTANGLE', 'ELLIPSE', 'VECTOR', 'LINE'].includes(node.type);
}

function isLayoutManagedDimension(node: SceneNode): boolean {
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    if ('primaryAxisSizingMode' in node && 'counterAxisSizingMode' in node) {
      return node.primaryAxisSizingMode !== 'FIXED' || node.counterAxisSizingMode !== 'FIXED';
    }
    return true;
  }

  const parent = node.parent;
  if (parent && 'layoutMode' in parent && parent.layoutMode !== 'NONE') {
    if ('layoutSizingHorizontal' in node && 'layoutSizingVertical' in node) {
      return node.layoutSizingHorizontal !== 'FIXED' || node.layoutSizingVertical !== 'FIXED';
    }
    return true;
  }

  return false;
}

function getStyleSolidColor(style: PaintStyle): RGB | null {
  const paint = style.paints.find((candidate) => candidate.type === 'SOLID' && candidate.visible !== false);
  return paint && paint.type === 'SOLID' ? paint.color : null;
}

function fontNamesMatch(a: FontName, b: FontName): boolean {
  return a.family === b.family && a.style === b.style;
}

async function scanStyles(nodes: SceneNode[]): Promise<ScanIssue[]> {
  const [paintStyles, textStyles] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
  ]);
  const issues: ScanIssue[] = [];
  const allStyles: Array<PaintStyle | TextStyle> = [...paintStyles, ...textStyles];
  const consumersByStyleId = new Map<string, StyleConsumers[]>();
  await Promise.all(allStyles.map(async (style) => {
    consumersByStyleId.set(style.id, await style.getStyleConsumersAsync());
  }));

  const duplicateGroups = new Map<string, Array<PaintStyle | TextStyle>>();
  for (const style of allStyles) {
    const signature = style.type === 'PAINT'
      ? `paint:${JSON.stringify(style.paints)}`
      : `text:${JSON.stringify({
          fontName: style.fontName,
          fontSize: style.fontSize,
          textDecoration: style.textDecoration,
          letterSpacing: style.letterSpacing,
          lineHeight: style.lineHeight,
        })}`;
    const group = duplicateGroups.get(signature) ?? [];
    group.push(style);
    duplicateGroups.set(signature, group);
  }

  for (const duplicateStyles of duplicateGroups.values()) {
    if (duplicateStyles.length < 2) continue;
    const canonical = [...duplicateStyles].sort(
      (a, b) => (consumersByStyleId.get(b.id)?.length ?? 0) - (consumersByStyleId.get(a.id)?.length ?? 0),
    )[0];
    const duplicates = duplicateStyles.filter((style) => style.id !== canonical.id);
    if (canonical.type === 'PAINT') {
      const duplicateConsumers = duplicates.flatMap((style) => consumersByStyleId.get(style.id) ?? [])
        .filter((consumer) => consumer.fields.includes('fillStyleId'));
      const nodeIds = [...new Set(duplicateConsumers.map((consumer) => consumer.node.id))];
      issues.push({
        id: `style-duplicates-paint-${duplicateStyles.map((style) => style.id).join('-')}`,
        category: 'styles',
        severity: 'low',
        title: `Duplicate paint styles: ${canonical.name}`,
        description: `${duplicateStyles.length} local paint styles have identical definitions. “${canonical.name}” is the most-used canonical style; ${duplicates.map((style) => `“${style.name}”`).join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} duplicates.`,
        nodeIds,
        fix: nodeIds.length > 0
          ? { type: 'style', nodeIds, styleId: canonical.id, styleName: canonical.name, styleKind: 'paint', styleField: 'fill' }
          : undefined,
      });
    } else {
      const duplicateConsumers = duplicates.flatMap((style) => consumersByStyleId.get(style.id) ?? [])
        .filter((consumer) => consumer.fields.includes('textStyleId'));
      const nodeIds = [...new Set(duplicateConsumers.map((consumer) => consumer.node.id))];
      issues.push({
        id: `style-duplicates-text-${duplicateStyles.map((style) => style.id).join('-')}`,
        category: 'styles',
        severity: 'low',
        title: `Duplicate text styles: ${canonical.name}`,
        description: `${duplicateStyles.length} local text styles have identical definitions. “${canonical.name}” is the most-used canonical style; ${duplicates.map((style) => `“${style.name}”`).join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} duplicates.`,
        nodeIds,
        fix: nodeIds.length > 0
          ? { type: 'style', nodeIds, styleId: canonical.id, styleName: canonical.name, styleKind: 'text', styleField: 'text' }
          : undefined,
      });
    }
  }

  for (const style of allStyles) {
    if ((consumersByStyleId.get(style.id) ?? []).length > 0) continue;
    const kindLabel = style.type === 'PAINT' ? 'color' : 'text';
    issues.push({
      id: `style-unused-${style.id}`,
      category: 'styles',
      severity: 'low',
      title: `Unused ${kindLabel} style: ${style.name}`,
      description: `“${style.name}” is a local ${kindLabel} style with no layers currently using it. Review whether it should be kept or removed manually.`,
      nodeIds: [],
    });
  }

  for (const style of paintStyles) {
    const styleColor = getStyleSolidColor(style);
    if (!styleColor) continue;
    const affected = nodes.filter((node) => {
      if (!('fills' in node) || !('fillStyleId' in node) || !('setFillStyleIdAsync' in node)) return false;
      if (node.fillStyleId !== '') return false;
      return Array.isArray(node.fills) && node.fills.some(
        (paint) => paint.type === 'SOLID' && paint.visible !== false && colorsMatch(paint.color, styleColor, 0.001),
      );
    });
    if (affected.length === 0) continue;

    const nodeIds = affected.map((node) => node.id);
    issues.push({
      id: `style-paint-${style.id}-${nodeIds.join('-')}`,
      category: 'styles',
      severity: 'low',
      title: `Color values not using shared style: ${style.name}`,
      description: `${affected.length} layer${affected.length === 1 ? '' : 's'} use the same color as “${style.name}” but are not connected to that shared paint style.`,
      nodeIds,
      fix: { type: 'style', nodeIds, styleId: style.id, styleName: style.name, styleKind: 'paint', styleField: 'fill' },
    });
  }

  for (const style of textStyles) {
    const affected = nodes.filter((node) => {
      if (node.type !== 'TEXT' || !('textStyleId' in node) || !('setTextStyleIdAsync' in node)) return false;
      if (node.textStyleId !== '' || node.fontName === figma.mixed || typeof node.fontSize !== 'number') return false;
      return fontNamesMatch(node.fontName as FontName, style.fontName) && Math.abs(node.fontSize - style.fontSize) < 0.001;
    });
    if (affected.length === 0) continue;

    const nodeIds = affected.map((node) => node.id);
    issues.push({
      id: `style-text-${style.id}-${nodeIds.join('-')}`,
      category: 'styles',
      severity: 'low',
      title: `Typography values not using shared style: ${style.name}`,
      description: `${affected.length} text layer${affected.length === 1 ? '' : 's'} match “${style.name}” but are not connected to that shared text style.`,
      nodeIds,
      fix: { type: 'style', nodeIds, styleId: style.id, styleName: style.name, styleKind: 'text', styleField: 'text' },
    });
  }

  return issues;
}

async function scanVariables(nodes: SceneNode[]): Promise<ScanIssue[]> {
  const [localColorVariables, localFloatVariables] = await Promise.all([
    figma.variables.getLocalVariablesAsync('COLOR'),
    figma.variables.getLocalVariablesAsync('FLOAT'),
  ]);
  const colorById = new Map(localColorVariables.map((variable) => [variable.id, variable]));
  const floatById = new Map(localFloatVariables.map((variable) => [variable.id, variable]));
  const issues: ScanIssue[] = [];
  const matches = new Map<string, { variableId: string; variableName: string; field: 'fill' | 'stroke' | VariableBindableNodeField; bindings: Array<{ nodeId: string; paintIndex?: number; field?: VariableBindableNodeField }> }>();
  const numericFields: Array<{ field: VariableBindableNodeField; label: string }> = [
    { field: 'itemSpacing', label: 'gap' },
    { field: 'paddingTop', label: 'top padding' },
    { field: 'paddingRight', label: 'right padding' },
    { field: 'paddingBottom', label: 'bottom padding' },
    { field: 'paddingLeft', label: 'left padding' },
    { field: 'cornerRadius', label: 'corner radius' },
    { field: 'topLeftRadius', label: 'top-left radius' },
    { field: 'topRightRadius', label: 'top-right radius' },
    { field: 'bottomRightRadius', label: 'bottom-right radius' },
    { field: 'bottomLeftRadius', label: 'bottom-left radius' },
    { field: 'gridRowGap', label: 'grid row gap' },
    { field: 'gridColumnGap', label: 'grid column gap' },
    { field: 'width', label: 'width' },
    { field: 'height', label: 'height' },
  ];
  const usedVariableIds = new Set<string>();
  const collectAliasIds = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(collectAliasIds); return; }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.type === 'VARIABLE_ALIAS' && typeof record.id === 'string') usedVariableIds.add(record.id);
    Object.values(record).forEach(collectAliasIds);
  };
  const addMatch = (variableId: string, variableName: string, field: 'fill' | 'stroke' | VariableBindableNodeField, binding: { nodeId: string; paintIndex?: number; field?: VariableBindableNodeField }): void => {
    const key = `${variableId}\u0000${field}`;
    const match = matches.get(key) ?? { variableId, variableName, field, bindings: [] };
    match.bindings.push(binding);
    matches.set(key, match);
  };

  for (const node of nodes) {
    collectAliasIds(node.boundVariables);
    const inferredFills = node.inferredVariables?.fills;
    if (inferredFills) {
      for (let paintIndex = 0; paintIndex < inferredFills.length; paintIndex += 1) {
        for (const alias of inferredFills[paintIndex] ?? []) {
          const variable = colorById.get(alias.id);
          if (variable) { addMatch(variable.id, variable.name, 'fill', { nodeId: node.id, paintIndex }); break; }
        }
      }
    }
    const inferredStrokes = node.inferredVariables?.strokes;
    if (inferredStrokes) {
      for (let paintIndex = 0; paintIndex < inferredStrokes.length; paintIndex += 1) {
        for (const alias of inferredStrokes[paintIndex] ?? []) {
          const variable = colorById.get(alias.id);
          if (variable) { addMatch(variable.id, variable.name, 'stroke', { nodeId: node.id, paintIndex }); break; }
        }
      }
    }
    const inferred = node.inferredVariables as { [field: string]: VariableAlias | undefined } | undefined;
    if (!inferred) continue;
    for (const { field } of numericFields) {
      if ((field === 'width' || field === 'height') && !isSafeDimensionNode(node)) continue;
      const alias = inferred[field];
      const variable = alias ? floatById.get(alias.id) : undefined;
      if (variable) addMatch(variable.id, variable.name, field, { nodeId: node.id, field });
    }
  }

  for (const match of matches.values()) {
    const nodeIds = [...new Set(match.bindings.map((binding) => binding.nodeId))];
    const fieldLabel = match.field === 'fill' ? 'color fill' : match.field === 'stroke' ? 'stroke color' : match.field.replace(/([A-Z])/g, ' $1').toLowerCase();
    issues.push({
      id: `variable-${match.variableId}-${match.field}-${nodeIds.join('-')}`,
      category: 'variables',
      severity: 'low',
      title: `${fieldLabel[0].toUpperCase()}${fieldLabel.slice(1)} matches variable: ${match.variableName}`,
      description: `${nodeIds.length} layer${nodeIds.length === 1 ? '' : 's'} use a ${fieldLabel} value that matches “${match.variableName}” but are not bound to that variable.`,
      nodeIds,
      fix: { type: 'variable', nodeIds, variableId: match.variableId, variableName: match.variableName, variableField: match.field, bindings: match.bindings },
    });
  }

  for (const variable of [...localColorVariables, ...localFloatVariables]) {
    if (usedVariableIds.has(variable.id) || matches.has(`${variable.id}\u0000fill`) || matches.has(`${variable.id}\u0000stroke`)) continue;
    issues.push({
      id: `variable-unused-${variable.id}`,
      category: 'variables',
      severity: 'low',
      title: `Unused variable in scanned scope: ${variable.name}`,
      description: `No scanned layer is currently bound to “${variable.name}”. It may still be used elsewhere in the file or on another page.`,
      nodeIds: [],
    });
  }
  return issues;
}
async function getVariableCoverage(nodes: SceneNode[]): Promise<VariableCoverage> {
  const [colorVariables, floatVariables] = await Promise.all([
    figma.variables.getLocalVariablesAsync('COLOR'),
    figma.variables.getLocalVariablesAsync('FLOAT'),
  ]);
  const numericFields: VariableBindableNodeField[] = [
    'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius',
  ];
  let boundValues = 0;
  let tokenizableValues = 0;
  for (const node of nodes) {
    if ('fills' in node && Array.isArray(node.fills)) {
      for (let index = 0; index < node.fills.length; index += 1) {
        if (node.fills[index].type !== 'SOLID') continue;
        tokenizableValues += 1;
        if (node.boundVariables?.fills?.[index]) boundValues += 1;
      }
    }
    if ('strokes' in node && Array.isArray(node.strokes)) {
      for (let index = 0; index < node.strokes.length; index += 1) {
        if (node.strokes[index].type !== 'SOLID') continue;
        tokenizableValues += 1;
        if (node.boundVariables?.strokes?.[index]) boundValues += 1;
      }
    }
    const bound = node.boundVariables as { [field: string]: VariableAlias | undefined } | undefined;
    for (const field of numericFields) {
      if (!(field in node) || typeof (node as unknown as Record<string, unknown>)[field] !== 'number') continue;
      tokenizableValues += 1;
      if (bound?.[field]) boundValues += 1;
    }
  }
  return {
    localVariableCount: colorVariables.length + floatVariables.length,
    boundValues,
    tokenizableValues,
    percentage: tokenizableValues === 0 ? 0 : Math.round((boundValues / tokenizableValues) * 100),
  };
}
async function scan(options: ScanOptions): Promise<{ issues: ScanIssue[]; nodeCount: number; variableCoverage?: VariableCoverage }> {
  reportScanProgress('Collecting layers…');
  const nodes = collectNodes(getNodesToScan(options.scope));
  const issues: ScanIssue[] = [];
  await yieldDuringScan();

  if (options.categories.includes('naming')) {
    reportScanProgress('Checking layer names…');
    issues.push(...scanNaming(nodes));
    await yieldDuringScan();
  }

  if (options.categories.includes('dimensions')) {
    reportScanProgress('Checking dimensions…');
    issues.push(...scanDimensions(nodes));
    await yieldDuringScan();
  }

  if (options.categories.includes('typography')) {
    reportScanProgress('Checking typography…');
    issues.push(...scanTypography(nodes));
    await yieldDuringScan();
  }
  if (options.categories.includes('spacing')) {
    reportScanProgress('Checking spacing…');
    issues.push(...scanSpacing(nodes));
    await yieldDuringScan();
  }
  if (options.categories.includes('radius')) {
    reportScanProgress('Checking radius…');
    issues.push(...scanRadii(nodes));
    await yieldDuringScan();
  }
  if (options.categories.includes('buttons')) {
    reportScanProgress('Checking buttons…');
    issues.push(...scanButtons(nodes));
    await yieldDuringScan();
  }
  if (options.categories.includes('components')) {
    reportScanProgress('Checking components…');
    issues.push(...await scanComponents(nodes));
    await yieldDuringScan();
  }
  if (options.categories.includes('accessibility')) {
    reportScanProgress('Checking accessibility…');
    issues.push(...scanAccessibility(nodes));
    await yieldDuringScan();
  }
  if (options.categories.includes('colors')) {
    reportScanProgress('Checking colors…');
    issues.push(...scanColors(nodes));
    await yieldDuringScan();
  }
  if (options.categories.includes('styles')) {
    reportScanProgress('Checking shared styles…');
    issues.push(...await scanStyles(nodes));
    await yieldDuringScan();
  }
  if (options.categories.includes('variables')) {
    reportScanProgress('Checking variables…');
    issues.push(...await scanVariables(nodes));
    await yieldDuringScan();
  }
  reportScanProgress('Preparing results…');
  const variableCoverage = options.categories.includes('variables') ? await getVariableCoverage(nodes) : undefined;
  return { issues, nodeCount: nodes.length, variableCoverage };
}

async function getSceneNode(nodeId: string): Promise<SceneNode | null> {
  const node = await figma.getNodeByIdAsync(nodeId);
  return node && node.type !== 'DOCUMENT' && node.type !== 'PAGE' ? node as SceneNode : null;
}

async function selectNodes(nodeIds: string[]): Promise<void> {
  const nodes: SceneNode[] = [];
  for (const nodeId of nodeIds) {
    const node = await getSceneNode(nodeId);
    if (node) nodes.push(node);
  }
  figma.currentPage.selection = nodes;
  if (nodes.length > 0) figma.viewport.scrollAndZoomIntoView(nodes);
}

async function applyColorFix(fix: Extract<FixAction, { type: 'color' }>): Promise<number> {
  let changed = 0;
  for (const nodeId of fix.nodeIds) {
    const node = await getSceneNode(nodeId);
    if (!node) continue;
    if ('fills' in node && Array.isArray(node.fills)) {
      let changedFills = false;
      const fills = node.fills.map((paint) => {
        if (paint.type === 'SOLID' && paint.visible !== false && colorsMatch(paint.color, fix.sourceColor, 0.04)) {
          changedFills = true;
          return { ...paint, color: fix.targetColor };
        }
        return paint;
      });
      if (changedFills) { node.fills = fills; changed += 1; }
    }
    if ('strokes' in node && Array.isArray(node.strokes)) {
      let changedStrokes = false;
      const strokes = node.strokes.map((paint) => {
        if (paint.type === 'SOLID' && paint.visible !== false && colorsMatch(paint.color, fix.sourceColor, 0.04)) {
          changedStrokes = true;
          return { ...paint, color: fix.targetColor };
        }
        return paint;
      });
      if (changedStrokes) { node.strokes = strokes; changed += 1; }
    }
  }
  return changed;
}

async function applyTypographyFix(fix: Extract<FixAction, { type: 'typography' }>): Promise<number> {
  let changed = 0;
  for (const nodeId of fix.nodeIds) {
    const node = await getSceneNode(nodeId);
    if (!node || node.type !== 'TEXT' || typeof node.fontSize !== 'number') continue;
    await figma.loadFontAsync(node.fontName as FontName);
    if (Math.abs(node.fontSize - fix.sourceSize) < 0.001) {
      node.fontSize = fix.targetSize;
      changed += 1;
    }
  }
  return changed;
}

async function applySpacingFix(fix: Extract<FixAction, { type: 'spacing' }>): Promise<number> {
  let changed = 0;

  for (const nodeId of fix.nodeIds) {
    const node = await getSceneNode(nodeId);
    if (!node) continue;

    if (fix.kind === 'gap' && 'layoutMode' in node && node.layoutMode !== 'NONE' && 'itemSpacing' in node) {
      if (Math.abs(node.itemSpacing - fix.sourceValue) < 0.001) {
        node.itemSpacing = fix.targetValue;
        changed += 1;
      }
      continue;
    }

    if (fix.kind === 'padding' && 'layoutMode' in node && node.layoutMode !== 'NONE') {
      let changedPadding = false;
      const sides = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
      for (const side of sides) {
        if (Math.abs(node[side] - fix.sourceValue) < 0.001) {
          node[side] = fix.targetValue;
          changedPadding = true;
        }
      }
      if (changedPadding) changed += 1;
    }
  }

  return changed;
}

async function applyRadiusFix(fix: Extract<FixAction, { type: 'radius' }>): Promise<number> {
  let changed = 0;
  for (const nodeId of fix.nodeIds) {
    const node = await getSceneNode(nodeId);
    if (!node || !('cornerRadius' in node) || typeof node.cornerRadius !== 'number') continue;
    if (Math.abs(node.cornerRadius - fix.sourceValue) < 0.001) {
      if (
        'topLeftRadius' in node &&
        'topRightRadius' in node &&
        'bottomRightRadius' in node &&
        'bottomLeftRadius' in node
      ) {
        node.topLeftRadius = fix.targetValue;
        node.topRightRadius = fix.targetValue;
        node.bottomRightRadius = fix.targetValue;
        node.bottomLeftRadius = fix.targetValue;
        changed += 1;
      }
    }
  }
  return changed;
}

async function applyButtonFix(fix: Extract<FixAction, { type: 'button' }>): Promise<number> {
  let changed = 0;
  for (const nodeId of fix.nodeIds) {
    const node = await getSceneNode(nodeId);
    if (!node || !('width' in node) || !('height' in node) || !('resize' in node)) continue;
    if (Math.abs(node.height - fix.sourceHeight) < 0.001) {
      const resizable = node as SceneNode & { resize: (width: number, height: number) => void };
      resizable.resize(node.width, fix.targetHeight);
      changed += 1;
    }
  }
  return changed;
}

async function applyComponentFix(fix: Extract<FixAction, { type: 'component' }>): Promise<number> {
  const canonical = await getSceneNode(fix.canonicalId);
  if (!canonical || canonical.type !== 'COMPONENT') return 0;

  let changed = 0;
  if (fix.mode === 'merge' || fix.mode === 'instance') await figma.loadAllPagesAsync();
  const instanceIds = fix.mode === 'merge' || fix.mode === 'instance'
    ? figma.root.findAll((node) => node.type === 'INSTANCE').map((node) => node.id)
    : fix.instanceIds;
  for (const instanceId of instanceIds) {
    const node = await getSceneNode(instanceId);
    if (!node || node.type !== 'INSTANCE') continue;
    const mainComponent = await node.getMainComponentAsync();
    if (!mainComponent || !fix.duplicateIds.includes(mainComponent.id)) continue;
    if (mainComponent.id === fix.canonicalId) continue;
    node.swapComponent(canonical);
    changed += 1;
  }

  if (fix.mode === 'merge' || fix.mode === 'instance') {
    for (const duplicateId of fix.duplicateIds) {
      if (duplicateId === fix.canonicalId) continue;
      const duplicate = await figma.getNodeByIdAsync(duplicateId);
      if (!duplicate || duplicate.type !== 'COMPONENT') continue;
      if (fix.mode === 'instance') {
        const parent = duplicate.parent;
        if (!parent || !('insertChild' in parent)) continue;
        const replacement = canonical.createInstance();
        const index = parent.children.indexOf(duplicate);
        parent.insertChild(index >= 0 ? index : parent.children.length, replacement);
        if ('x' in duplicate && 'y' in duplicate) {
          replacement.x = duplicate.x;
          replacement.y = duplicate.y;
        }
        if ('rotation' in duplicate) replacement.rotation = duplicate.rotation;
        if ('opacity' in duplicate) replacement.opacity = duplicate.opacity;
        if ('visible' in duplicate) replacement.visible = duplicate.visible;
        if ('width' in duplicate && 'height' in duplicate && 'resize' in replacement) {
          const resizable = replacement as InstanceNode & { resize: (width: number, height: number) => void };
          resizable.resize(duplicate.width, duplicate.height);
        }
      }
      duplicate.remove();
      changed += 1;
    }
  }
  return changed;
}

async function renameDuplicateComponents(
  nodeIds: string[],
  canonicalId: string,
  baseName: string,
): Promise<number> {
  let changed = 0;
  let duplicateNumber = 2;
  for (const nodeId of nodeIds) {
    if (nodeId === canonicalId) continue;
    const node = await getSceneNode(nodeId);
    if (!node || node.type !== 'COMPONENT') continue;
    node.name = `${baseName.trim() || 'Component'} ${duplicateNumber}`;
    duplicateNumber += 1;
    changed += 1;
  }
  return changed;
}

async function applyNamingFix(fix: Extract<FixAction, { type: 'naming' }>): Promise<number> {
  let changed = 0;
  const baseName = fix.targetName.trim() || 'Layer';
  for (let index = 0; index < fix.nodeIds.length; index += 1) {
    const node = await getSceneNode(fix.nodeIds[index]);
    if (!node) continue;
    node.name = `${baseName} ${index + 1}`;
    changed += 1;
  }
  return changed;
}

async function applyDimensionsFix(fix: Extract<FixAction, { type: 'dimensions' }>): Promise<number> {
  let changed = 0;
  for (const nodeId of fix.nodeIds) {
    const node = await getSceneNode(nodeId);
    if (!node || !isSafeDimensionNode(node)) continue;
    const resizable = node as SceneNode & { resize: (width: number, height: number) => void };
    resizable.resize(fix.targetWidth, fix.targetHeight);
    changed += 1;
  }
  return changed;
}

async function applyStyleFix(fix: Extract<FixAction, { type: 'style' }>): Promise<number> {
  let changed = 0;
  for (const nodeId of fix.nodeIds) {
    const node = await getSceneNode(nodeId);
    if (!node) continue;

    if (fix.styleKind === 'paint' && 'setFillStyleIdAsync' in node && 'fillStyleId' in node) {
      if (node.fillStyleId === '') {
        await node.setFillStyleIdAsync(fix.styleId);
        changed += 1;
      }
      continue;
    }

    if (fix.styleKind === 'text' && node.type === 'TEXT' && 'setTextStyleIdAsync' in node && 'textStyleId' in node) {
      if (node.textStyleId === '') {
        await figma.loadFontAsync(node.fontName as FontName);
        await node.setTextStyleIdAsync(fix.styleId);
        changed += 1;
      }
    }
  }
  return changed;
}

async function applyVariableFix(fix: Extract<FixAction, { type: 'variable' }>): Promise<number> {
  const variable = await figma.variables.getVariableByIdAsync(fix.variableId);
  if (!variable || variable.remote) return 0;

  if (fix.variableField !== 'fill' && fix.variableField !== 'stroke') {
    if (variable.resolvedType !== 'FLOAT') return 0;
    let changed = 0;
    for (const binding of fix.bindings) {
      const node = await getSceneNode(binding.nodeId);
      if (!node || !binding.field || !('setBoundVariable' in node)) continue;
      node.setBoundVariable(binding.field, variable);
      changed += 1;
    }
    return changed;
  }

  if (variable.resolvedType !== 'COLOR') return 0;
  const bindingsByNode = new Map<string, number[]>();
  for (const binding of fix.bindings) {
    if (binding.paintIndex === undefined) continue;
    const indexes = bindingsByNode.get(binding.nodeId) ?? [];
    indexes.push(binding.paintIndex);
    bindingsByNode.set(binding.nodeId, indexes);
  }
  let changed = 0;
  for (const [nodeId, paintIndexes] of bindingsByNode) {
    const node = await getSceneNode(nodeId);
    const paints = fix.variableField === 'fill' ? ('fills' in (node ?? {}) ? (node as SceneNode & { fills: readonly Paint[] }).fills : null) : ('strokes' in (node ?? {}) ? (node as SceneNode & { strokes: readonly Paint[] }).strokes : null);
    if (!node || !paints || !Array.isArray(paints)) continue;
    let changedPaint = false;
    const nextPaints = paints.map((paint, index) => {
      if (!paintIndexes.includes(index) || paint.type !== 'SOLID') return paint;
      changedPaint = true;
      return figma.variables.setBoundVariableForPaint(paint, 'color', variable);
    });
    if (!changedPaint) continue;
    if (fix.variableField === 'fill' && 'setFillsAsync' in node) await node.setFillsAsync(nextPaints);
    if (fix.variableField === 'stroke' && 'setStrokesAsync' in node) await node.setStrokesAsync(nextPaints);
    changed += 1;
  }
  return changed;
}
figma.ui.onmessage = async (msg: {
  type: string;
  options?: ScanOptions;
  nodeIds?: string[];
  selectionIssueId?: string;
  canonicalId?: string;
  name?: string;
  issueId?: string;
  fix?: FixAction;
}) => {
  if (msg.type === 'scan' && msg.options) {
    scanCancelled = false;
    try {
      figma.ui.postMessage({ type: 'scan-results', result: await scan(msg.options) });
    } catch (error) {
      if (scanCancelled || (error instanceof Error && error.message === '__SCAN_CANCELLED__')) {
        figma.ui.postMessage({ type: 'scan-cancelled' });
        return;
      }
      const errorMessage = error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
      figma.ui.postMessage({ type: 'scan-failed', error: errorMessage || 'The scan could not be completed.' });
    }
    return;
  }

  if (msg.type === 'cancel-scan') {
    scanCancelled = true;
    return;
  }

  if (msg.type === 'select-nodes' && msg.nodeIds) {
    await selectNodes(msg.nodeIds);
    figma.ui.postMessage({ type: 'selection-applied', issueId: msg.selectionIssueId, count: msg.nodeIds.length });
    return;
  }

  if (msg.type === 'undo-fix') {
    try {
      figma.triggerUndo();
      figma.ui.postMessage({ type: 'undo-applied' });
    } catch (error) {
      const errorMessage = error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
      figma.ui.postMessage({ type: 'undo-failed', error: errorMessage || 'The change could not be undone.' });
    }
    return;
  }

  if (msg.type === 'apply-fix' && msg.fix && msg.issueId) {
    try {
      const changed = msg.fix.type === 'color'
        ? await applyColorFix(msg.fix)
        : msg.fix.type === 'typography'
          ? await applyTypographyFix(msg.fix)
          : msg.fix.type === 'spacing'
            ? await applySpacingFix(msg.fix)
            : msg.fix.type === 'radius'
              ? await applyRadiusFix(msg.fix)
              : msg.fix.type === 'button'
                ? await applyButtonFix(msg.fix)
                : msg.fix.type === 'component'
                  ? await applyComponentFix(msg.fix)
                : msg.fix.type === 'naming'
                  ? await applyNamingFix(msg.fix)
                    : msg.fix.type === 'dimensions'
                      ? await applyDimensionsFix(msg.fix)
                      : msg.fix.type === 'style'
                        ? await applyStyleFix(msg.fix)
                        : await applyVariableFix(msg.fix);
      figma.ui.postMessage({
        type: 'fix-applied',
        issueId: msg.issueId,
        changed,
        action: msg.fix.type === 'component' ? msg.fix.mode : msg.fix.type,
      });
    } catch (error) {
      const errorMessage = error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
      figma.ui.postMessage({
        type: 'fix-failed',
        issueId: msg.issueId,
        action: msg.fix.type === 'component' ? msg.fix.mode : msg.fix.type,
        error: errorMessage || 'The fix could not be applied.',
      });
    }
    return;
  }

  if (
    msg.type === 'rename-components' &&
    msg.issueId &&
    msg.nodeIds &&
    msg.canonicalId &&
    msg.name !== undefined
  ) {
    try {
      const changed = await renameDuplicateComponents(msg.nodeIds, msg.canonicalId, msg.name);
      figma.ui.postMessage({ type: 'fix-applied', issueId: msg.issueId, changed, action: 'rename' });
    } catch (error) {
      const errorMessage = error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
      figma.ui.postMessage({ type: 'fix-failed', issueId: msg.issueId, action: 'rename', error: errorMessage });
    }
    return;
  }

  if (msg.type === 'close') figma.closePlugin();
};
