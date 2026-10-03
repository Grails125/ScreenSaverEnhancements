import en from './i18n/en.json'
import uk from './i18n/uk.json'
import zhCn from './i18n/zh-cn.json'

type TranslationKey = keyof typeof en
const languages: Record<'en' | 'uk' | 'zhCn', Partial<Record<TranslationKey, string>>> = {
  en,
  uk,
  zhCn,
}

function getCurrentLanguage(): keyof typeof languages {
  const steamLang = String(
    window.LocalizationManager.m_rgLocalesToUse[0] ?? 'en'
  ).toLowerCase()

  const aliases: Record<string, keyof typeof languages> = {
    en: 'en',
    english: 'en',
    'en-us': 'en',
    uk: 'uk',
    'uk-ua': 'uk',
    ukrainian: 'uk',
    'zh-cn': 'zhCn',
    zhcn: 'zhCn',
    'zh_cn': 'zhCn',
    schinese: 'zhCn',
  }

  return aliases[steamLang] ?? 'en'
}

function useTranslations(lang: keyof typeof languages) {
  return function (key: TranslationKey): string {
    const translated = languages[lang][key]
    return translated?.length ? translated : en[key] || key
  }
}

export default { getCurrentLanguage, useTranslations }
