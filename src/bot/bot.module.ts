import { Module } from '@nestjs/common';
import { ParticipantsModule } from '../participants/participants.module';
import { PaymentsModule } from '../payments/payments.module';
import { BotUpdate } from './bot.update';
import { PaymentUpdate } from './payment.update';
import { LanguageScene } from './scenes/language.scene';
import { OnboardingScene } from './scenes/onboarding.scene';
import { TrackSplitScene } from './scenes/track-split.scene';

@Module({
  imports: [ParticipantsModule, PaymentsModule],
  providers: [
    BotUpdate,
    PaymentUpdate,
    LanguageScene,
    OnboardingScene,
    TrackSplitScene,
  ],
})
export class BotModule {}
