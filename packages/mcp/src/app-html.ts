const moduleTag = '<script type="module" src="./preview.js"></script>';

export function inlineAppModule(template: string, script: string, initialState?: unknown): string {
  const inlineModule = script.replace(/<\/script/gi, "<\\/script");
  const bootstrap =
    initialState === undefined
      ? ""
      : `<script>window.__SIMVIEW_INITIAL_STATE__=${JSON.stringify(initialState)
          .replace(/</g, "\\u003c")
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029")};</script>`;
  return template.replace(
    moduleTag,
    () => `${bootstrap}<script type="module">${inlineModule}</script>`,
  );
}
