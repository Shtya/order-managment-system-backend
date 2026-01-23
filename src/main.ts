import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { QueryFailedErrorFilter } from 'common/QueryFailedErrorFilter';

async function bootstrap() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule);

	app.useGlobalFilters(app.get(QueryFailedErrorFilter));

	// Static files (fix the path: no leading "/uploads")
	app.useStaticAssets(join(__dirname, '..', '..', 'uploads'), {
		prefix: '/uploads/',
	});

	// CORS + global prefix + validation
	app.enableCors({});
	app.useGlobalPipes(
		new ValidationPipe({
			disableErrorMessages: false,
			transform: true,
			forbidNonWhitelisted: true,
			whitelist: true,
		}),
	);

	const port = process.env.PORT || 3030;

	// VPS / PM2: we ALWAYS listen here
	await app.listen(port as number, '0.0.0.0');
	Logger.log(`🚀 Server is running on http://localhost:${port}`, 'Bootstrap');
}

bootstrap();



