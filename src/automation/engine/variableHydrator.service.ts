//A utility service. Its only job is to take a Node's raw JSON config and a executionState object,
//  and return a "ready-to-use" config with all {{variables}} replaced with real data.


import { Injectable } from '@nestjs/common';
import { ExecutionState } from 'entities/automation.entity';

@Injectable()
export class VariableHydratorService {

    /**
     * يأخذ مساراً نصياً مثل "trigger.output.customer.phone" ويستخرج قيمته من الـ executionState
     */
    getValueFromState(path: string, state: ExecutionState): any {
        if (!path) return null;
        try {
            // فك النص بناءً على النقطة والتحرك داخل كائن الـ JSON
            return path.split('.').reduce((obj, key) => {
                return (obj && obj[key] !== undefined) ? obj[key] : null;
            }, state as any);
        } catch (error) {
            return null;
        }
    }

    /**
     * دالة ذكية تقوم بفحص أي كائن أو نص أو مصفوفة (Node Config) وتعويض المتغيرات فيها بشكل ريكيرسيف (Recursive)
     */
    hydrate<T>(config: T, state: ExecutionState): T {
        if (!config) return config;

        // إذا كان الإعداد عبارة عن نص، نقوم بفحصه واستبداله
        if (typeof config === 'string') {
            return this.replaceTokens(config, state) as unknown as T;
        }

        // إذا كانت مصفوفة، نقوم بعمل الفحص لكل عنصر فيها
        if (Array.isArray(config)) {
            return config.map(item => this.hydrate(item, state)) as unknown as T;
        }

        // إذا كان كائن (Object)، نقوم بلف جميع الـ Keys الخاصة به وتطهيرها
        if (typeof config === 'object') {
            const hydratedObj = {};
            for (const key of Object.keys(config)) {
                hydratedObj[key] = this.hydrate(config[key], state);
            }
            return hydratedObj as T;
        }

        return config;
    }

    /**
     * المعالج الداخلي للتعرف على الـ Regex الخاص بالمتغيرات {{ variable }}
     */
    private replaceTokens(text: string, state: ExecutionState): any {
        const regex = /{{\s*([\w.]+)\s*}}/g;

        // حالة خاصة: إذا كان النص بالكامل عبارة عن متغير واحد فقط (مثل رقم أو كائن كامل)
        // نريد إرجاع القيمة بنوعها الأصلي (Primitive Type) وليس كـ String مدمج
        const matches = [...text.matchAll(regex)];
        if (matches.length === 1 && matches[0][0] === text) {
            const path = matches[0][1];
            return this.getValueFromState(path, state);
        }

        // حالة الدمج النصي: مثل "مرحباً يا {{trigger.output.customer.name}}، طلبك جاهز"
        return text.replace(regex, (match, path) => {
            const value = this.getValueFromState(path, state);
            return value !== null && value !== undefined ? String(value) : '';
        });
    }
}