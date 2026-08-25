import en from './i18n/en.json'
import uk from './i18n/uk.json'
import zhCn from './i18n/zh-cn.json'

const languages = {
  en,
  uk,
  zhCn,
} as const

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
  return function (key: keyof (typeof languages)['en']): string {
    if (languages[lang]?.[key]?.length) {
      return languages[lang][key]
    } else if (languages.en?.[key]?.length) {
      return languages.en[key]
    } else {
      return key.toString()
    }
  }
}

export default { getCurrentLanguage, useTranslations }
