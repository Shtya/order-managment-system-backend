import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { GlobalExceptionFilter  } from 'common/GlobalExceptionFilter';
import * as bodyParser from 'body-parser';
import helmet from 'helmet';
async function bootstrap() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule);

	app.useGlobalFilters(app.get(GlobalExceptionFilter ));

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
		new ValidationPipe({
			disableErrorMessages: false,
			transform: true,
			forbidNonWhitelisted: true,
			whitelist: true,
		}),
	);

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

	app.use(helmet());
	// VPS / PM2: we ALWAYS listen here
	await app.listen(port as number, '0.0.0.0');
	Logger.log(`🚀 Server is running on http://localhost:${port}`, 'Bootstrap');
}

bootstrap();



