const moduleTag = '<script type="module" src="./preview.js"></script>';

export function inlineAppModule(template: string, script: string): string {
  const inlineModule = script.replace(/<\/script/gi, "<\\/script");
  return template.replace(
    moduleTag,
    () => `<script type="module">${inlineModule}</script>`,
  );
}
