import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../shared/auth/public.decorator';
import { HttpResult } from '../shared/envelope/http-result';
import { allDetailMessages } from '../shared/i18n/catalog';
import { ApiCatalogResponses } from '../wagering/wagering.swagger';

@ApiTags('i18n')
@Public()
@Controller('i18n')
export class I18nController {
  @Get()
  @ApiCatalogResponses()
  catalog() {
    return HttpResult.ok(allDetailMessages());
  }
}
