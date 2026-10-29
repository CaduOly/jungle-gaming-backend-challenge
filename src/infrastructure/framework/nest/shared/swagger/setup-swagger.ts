import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export const createOpenApiDocument = (app: INestApplication): OpenAPIObject =>
  SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Jungle Wagering')
      .setDescription(
        'Wallet and wager transaction API. Every business endpoint answers in the envelope ' +
          '{ code, message, data, timestamp, detailsMessage[] }; detailsMessage[].message is an i18n key (see GET /i18n).',
      )
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Development: "dev:<providerId>".' })
      .build(),
  );

/** UI at /docs, OpenAPI 3 JSON at /docs-json; both open (outside the provider guard). */
export const setupSwagger = (app: INestApplication): OpenAPIObject => {
  const document = createOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });
  return document;
};
