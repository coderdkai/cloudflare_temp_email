import { createI18n } from 'vue-i18n'

import {
    FALLBACK_LOCALE,
    getInitialLocale,
} from './utils'
import { I18N_MESSAGES } from './messages'

const i18n = createI18n({
    legacy: false, // you must set `false`, to use Composition API
    locale: getInitialLocale(),
    fallbackLocale: FALLBACK_LOCALE,
    // SAFETY: I18N_MESSAGES matches vue-i18n LocaleMessage dictionary structure built from message registry
    messages: I18N_MESSAGES as unknown as Record<string, Record<string, string>>,
    missingWarn: false,
    fallbackWarn: false,
})

export default i18n;
