import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import githubDark from '@shikijs/themes/github-dark';
import githubLight from '@shikijs/themes/github-light';
import type { HistoryCodeTokenizer } from './HistoryPatchSyntaxHighlighter';
import type { HistorySyntaxToken } from './HistoryDiffSupport';

const DEFAULT_LIGHT = '#24292e';
const DEFAULT_DARK = '#e1e4e8';

const EXTENSION_LANGUAGES = new Map<string, string>([
  ['.bash', 'shellscript'], ['.c', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.cs', 'csharp'],
  ['.css', 'css'], ['.dart', 'dart'], ['.go', 'go'], ['.htm', 'html'], ['.html', 'html'],
  ['.java', 'java'], ['.js', 'javascript'], ['.json', 'json'], ['.jsonc', 'jsonc'],
  ['.jsx', 'jsx'], ['.kt', 'kotlin'], ['.kts', 'kotlin'], ['.md', 'markdown'],
  ['.mdx', 'markdown'], ['.mjs', 'javascript'], ['.php', 'php'], ['.py', 'python'],
  ['.rb', 'ruby'], ['.rs', 'rust'], ['.scss', 'scss'], ['.sh', 'shellscript'], ['.sql', 'sql'],
  ['.svelte', 'svelte'], ['.swift', 'swift'], ['.ts', 'typescript'], ['.tsx', 'tsx'],
  ['.vue', 'vue'], ['.yaml', 'yaml'], ['.yml', 'yaml'],
]);

type LanguageLoader = () => Promise<readonly LanguageInput[]>;

const LANGUAGE_LOADERS = new Map<string, LanguageLoader>([
  ['c', async () => (await import('@shikijs/langs/c')).default],
  ['cpp', async () => (await import('@shikijs/langs/cpp')).default],
  ['csharp', async () => (await import('@shikijs/langs/csharp')).default],
  ['css', async () => (await import('@shikijs/langs/css')).default],
  ['dart', async () => (await import('@shikijs/langs/dart')).default],
  ['go', async () => (await import('@shikijs/langs/go')).default],
  ['html', async () => (await import('@shikijs/langs/html')).default],
  ['java', async () => (await import('@shikijs/langs/java')).default],
  ['javascript', async () => (await import('@shikijs/langs/javascript')).default],
  ['json', async () => (await import('@shikijs/langs/json')).default],
  ['jsonc', async () => (await import('@shikijs/langs/jsonc')).default],
  ['jsx', async () => (await import('@shikijs/langs/jsx')).default],
  ['kotlin', async () => (await import('@shikijs/langs/kotlin')).default],
  ['markdown', async () => (await import('@shikijs/langs/markdown')).default],
  ['php', async () => (await import('@shikijs/langs/php')).default],
  ['python', async () => (await import('@shikijs/langs/python')).default],
  ['ruby', async () => (await import('@shikijs/langs/ruby')).default],
  ['rust', async () => (await import('@shikijs/langs/rust')).default],
  ['scss', async () => (await import('@shikijs/langs/scss')).default],
  ['shellscript', async () => (await import('@shikijs/langs/shellscript')).default],
  ['sql', async () => (await import('@shikijs/langs/sql')).default],
  ['svelte', async () => (await import('@shikijs/langs/svelte')).default],
  ['swift', async () => (await import('@shikijs/langs/swift')).default],
  ['tsx', async () => (await import('@shikijs/langs/tsx')).default],
  ['typescript', async () => (await import('@shikijs/langs/typescript')).default],
  ['vue', async () => (await import('@shikijs/langs/vue')).default],
  ['yaml', async () => (await import('@shikijs/langs/yaml')).default],
]);

function extension(path: string): string {
  const basename = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const dot = basename.lastIndexOf('.');
  return dot < 0 ? '' : basename.slice(dot);
}

function languageForPath(path: string): string | undefined {
  const basename = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  if (basename === 'dockerfile') return 'shellscript';
  return EXTENSION_LANGUAGES.get(extension(path));
}

function plainTokens(code: string): readonly (readonly HistorySyntaxToken[])[] {
  return code.split('\n').map((line) => [{
    content: line,
    light: DEFAULT_LIGHT,
    dark: DEFAULT_DARK,
  }]);
}

export class ShikiHistoryWorkerTokenizer implements HistoryCodeTokenizer {
  private highlighter: Promise<HighlighterCore> | undefined;
  private readonly languageLoads = new Map<string, Promise<void>>();

  async tokenize(
    code: string,
    path: string,
  ): Promise<readonly (readonly HistorySyntaxToken[])[]> {
    const language = languageForPath(path);
    if (!language) return plainTokens(code);
    const highlighter = await (this.highlighter ??= createHighlighterCore({
      themes: [githubLight, githubDark],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }));
    let load = this.languageLoads.get(language);
    if (!load) {
      const loader = LANGUAGE_LOADERS.get(language);
      if (!loader) return plainTokens(code);
      load = loader().then((inputs) => highlighter.loadLanguage(...inputs));
      this.languageLoads.set(language, load);
    }
    await load;
    return highlighter.codeToTokensWithThemes(code, {
      lang: language,
      themes: { light: 'github-light', dark: 'github-dark' },
    }).map((line) => line.map((token) => ({
      content: token.content,
      light: token.variants.light?.color ?? DEFAULT_LIGHT,
      dark: token.variants.dark?.color ?? DEFAULT_DARK,
    })));
  }

  dispose(): void {
    const highlighter = this.highlighter;
    this.highlighter = undefined;
    this.languageLoads.clear();
    if (highlighter) void highlighter.then((instance) => instance.dispose());
  }
}
