import { Module } from '@nestjs/common';
import { SheetsSyncModule } from '../sheets/sheets.module';
import { ParticipantsService } from './participants.service';

@Module({
  imports: [SheetsSyncModule],
  providers: [ParticipantsService],
  exports: [ParticipantsService],
})
export class ParticipantsModule {}
