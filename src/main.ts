import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { GlobalExceptionFilter, QueryExceptionFilter } from 'common/GlobalExceptionFilter';
import * as bodyParser from 'body-parser';
import helmet from 'helmet';
import { I18nValidationExceptionFilter, I18nValidationPipe } from 'nestjs-i18n';
import { ValidationError } from 'class-validator';


async function bootstrap() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule);

	app.useGlobalFilters(
		app.get(GlobalExceptionFilter),
		app.get(QueryExceptionFilter),
	);

	// Static files (fix the path: no leading "/uploads")
	app.useStaticAssets(join(__dirname, '..', '..', 'uploads'), {
		prefix: '/uploads/',
	});

	// CORS + global prefix + validation
	app.enableCors(
		{
			origin: '*', // Allowed origins
			methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
			credentials: true,
			allowedHeaders: '*',
		}
	);
	app.useGlobalPipes(
		new I18nValidationPipe({
			disableErrorMessages: false,
			transform: true,
			forbidNonWhitelisted: true,
			whitelist: true,
		}),
	);

	app.useGlobalFilters(
		new I18nValidationExceptionFilter({
			errorFormatter: (errors: ValidationError[]) => {
				return {
					messages: flatten(errors),
					fields: groupByProperty(errors),
				};
			},
			responseBodyFormatter: (_host, exc, formattedErrors: any) => ({
				statusCode: exc.getStatus(),
				message: formattedErrors.messages,
				errors: formattedErrors.fields,
				error: 'Bad Request',
			}),
		}),
	);

	function groupByProperty(
		errors: ValidationError[],
	): Record<string, string[]> {
		const result: Record<string, string[]> = {};
		
		const visit = (errs: ValidationError[], path = '') => {
			for (const err of errs) {
				const key = path ? `${path}.${err.property}` : err.property;

				if (err.constraints) {
					result[key] = Object.values(err.constraints);
				}

				if (err.children?.length) {
					visit(err.children, key);
				}
			}
		};

		visit(errors);

		return result;
	}

	function flatten(errors: ValidationError[]): string[] {
		const messages: string[] = [];

		const visit = (errs: ValidationError[]) => {
			for (const err of errs) {
				if (err.constraints) {
					messages.push(...Object.values(err.constraints));
				}
				if (err.children?.length) {
					visit(err.children);
				}
			}
		};

		visit(errors);

		return messages;
	}

	const port = process.env.PORT || 3030;

	app.use(
		bodyParser.json({
			verify: (req: any, res, buf) => {
				req.rawBody = buf;
			},
		}),
	);

	app.use((req: any, res, next) => {
		req.startTime = Date.now();
		next();
	});

	app.use(
		helmet({
			crossOriginResourcePolicy: {
				policy: "cross-origin",
			},
		}),
	);

	// VPS / PM2: we ALWAYS listen here
	await app.listen(port as number, '0.0.0.0');
	Logger.log(`🚀 Server is running on http://localhost:${port}`, 'Bootstrap');
}

bootstrap();



