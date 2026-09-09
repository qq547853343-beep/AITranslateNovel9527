export class LegacyTranslationService {
  constructor({ providerFactory }) { this.providerFactory = providerFactory; }

  async translate({ text, targetLanguage = '中文', filename = 'translation.txt' }) {
    const source = String(text || '');
    if (!source.trim()) throw Object.assign(new Error('请输入文字或选择文件。'), { status: 400 });
    const provider = await this.providerFactory();
    const translation = await provider.translateText({ text: source, targetLanguage: String(targetLanguage || '中文').slice(0, 40) });
    return { translation, filename };
  }
}
