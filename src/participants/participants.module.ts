import { Module } from '@nestjs/common';
import { ParticipantsService } from './participants.service';

@Module({
  providers: [ParticipantsService],
  exports: [ParticipantsService],
})
export class ParticipantsModule {}
