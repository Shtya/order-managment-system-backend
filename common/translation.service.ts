// common/translation/translation.service.ts
import { forwardRef, Global, Inject, Injectable, Module, Scope } from '@nestjs/common';
import { ModuleRef, REQUEST } from '@nestjs/core';
import { I18nTranslations } from 'messages.generated';
import { I18nService, I18nContext, TranslateOptions } from 'nestjs-i18n';
import { ClientSettingsService } from 'src/client-settings/client-settings.service';
import { AcceptLanguageResolver, CookieResolver, HeaderResolver, I18nModule, QueryResolver } from "nestjs-i18n";
import { join } from 'path';
import { ClientSettingsModule } from 'src/client-settings/client-settings.module';

/** Helper type that produces dot-paths for nested object keys
 *  Example: { events: { user_not_found: string, nested: { a: string } } }
 *  produces: "events" | "events.user_not_found" | "events.nested" | "events.nested.a"
 */
export type TranslationKeys<T> = T extends object
    ? {
        [K in Extract<keyof T, string>]:
        T[K] extends object ? `${K}` | `${K}.${TranslationKeys<T[K]>}` : `${K}`;
    }[Extract<keyof T, string>]
    : never;

/** Concrete union of all valid keys from generated translations */
export type I18nKey = TranslationKeys<I18nTranslations>;
export type CustomTranslateOptions = TranslateOptions & {
    fromSettings?: boolean;
};

@Injectable()
export class TranslationService {
    constructor(
        private readonly i18n: I18nService<I18nTranslations>,
    ) { }


    t<Key extends I18nKey>(
        key: Key,
        options?: TranslateOptions,
    ) {
        const lang = options?.lang ?? I18nContext.current()?.lang;

        return this.i18n.t(key as any, {
            ...options,
            lang,
        });
    }
}

export class RequestTranslationService {
    constructor(
        @Inject(forwardRef(() => TranslationService))
        private readonly translationService: TranslationService,
        @Inject(forwardRef(() => ClientSettingsService))
        private readonly clientSettingsService: ClientSettingsService,
    ) {
    }

    /**
     * Resolves the current logged-in user's custom language settings, 
     * then executes translation via the base TranslationService.
     */
    async tAsync<Key extends I18nKey>(
        key: Key,
        userId: string,
        options?: CustomTranslateOptions,
    ) {
        let lang = options?.lang ?? I18nContext.current()?.lang;
        const useSettings = options?.fromSettings ?? true;

        if (useSettings) {

            if (userId) {
                try {
                    const settings = await this.clientSettingsService.getCachedSettings(userId);
                    lang = settings?.defaultLang ?? lang;
                } catch (error) {
                    // Fail gracefully and fallback to context language
                    console.error("Failed to get user settings:", error);
                }
            }
        }

        // Forward resolved language straight to the core service
        return this.translationService.t(key, {
            ...options,
            lang,
        });
    }
}

@Global()
@Module({
    imports: [
        I18nModule.forRootAsync({
            useFactory: () => ({
                fallbackLanguage: 'en',
                loaderOptions: {
                    path: join(process.cwd(), 'messages'),
                    watch: true,
                },
                typesOutputPath: join(process.cwd(), 'messages.generated.ts'),
            }),
            resolvers: [
                new QueryResolver(['lang', 'l']),
                new HeaderResolver(['x-lang']),
                new CookieResolver(),
                AcceptLanguageResolver,
            ]
        }),
        forwardRef(() => ClientSettingsModule),
    ],
    providers: [TranslationService, RequestTranslationService],
    exports: [TranslationService, RequestTranslationService],
})
export class TranslationModule { }