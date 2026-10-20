/**
 * Every user-facing bot string, keyed by message id, in all three languages.
 * `en` defines the key set; `uz` and `ru` must provide every key (enforced by
 * the type of `translations`). `{name}`-style placeholders are filled by `t()`.
 */

export const LANGUAGES = ['uz', 'ru', 'en'] as const;
export type Lang = (typeof LANGUAGES)[number];

const en = {
  'language.name': 'English',
  'language.prompt': 'Please choose your language:',

  'registration.welcome':
    'Welcome to Job & Edu Fair 2026! Let’s get you registered.',
  'registration.alreadyRegistered':
    'You are already registered for Job & Edu Fair 2026. Send /status to see your payment status.',
  'registration.closed':
    'Sorry, registration is closed — all places are taken.',
  'registration.cancelled':
    'Registration cancelled. Send /start to begin again.',
  'registration.sessionExpired':
    'Your session expired. Please send /start to register again.',
  'registration.invalid':
    'Some of your answers were invalid. Please send /start to try again.',
  'registration.success':
    '✅ You’re registered, {name}!\nTrack: {track}\n\n' +
    'Next step: the 50 000 so‘m participation fee.',

  'error.tryAgainLater':
    'Something went wrong on our side. Please try again in a minute.',
  'common.pickButton': 'Please pick one of the buttons below.',

  'phone.button': '📱 Share phone number',
  'phone.prompt': 'Please share your phone number using the button below.',
  'phone.useButton': 'Please tap “{button}” below.',
  'phone.notOwn': 'Please share your own phone number using the button below.',

  'fullName.prompt': 'Thanks! Now send your full name (first and last name).',
  'fullName.invalid':
    'Please send your first and last name, e.g. “Aziz Karimov”.',

  'birthYearOrCourse.prompt':
    'Your birth year, or your course if you are a student (e.g. “2003” or “3rd year”):',
  'birthYearOrCourse.invalid': 'Please send your birth year or course as text.',

  'direction.prompt': 'Choose your main direction:',
  'direction.Frontend': 'Frontend',
  'direction.Backend': 'Backend',
  'direction.Mobile': 'Mobile',
  'direction.UI/UX': 'UI/UX',
  'direction.QA': 'QA',
  'direction.Data Science': 'Data Science',
  'direction.DevOps': 'DevOps',
  'direction.Other': 'Other',

  'filter.prompt': 'Do you already have an IT skill and a portfolio or resume?',
  'filter.yes': '✅ Yes, I have a skill + portfolio/resume',
  'filter.no': '📚 No, I’m still learning',

  'cvLink.prompt':
    'Great! Send a link to your resume or portfolio (https://…).',
  'cvLink.invalid':
    'That doesn’t look like a link. Please send a full URL, e.g. https://github.com/you',

  'track.JOB': 'Job Track',
  'track.EDU': 'Edu Track',

  'payment.offer':
    '💳 Participation fee: {amount} so‘m.\n' +
    'Tap the button below to pay with Click. Send /status any time to check your payment.',
  'payment.button': '💳 Pay {amount} so‘m with Click',
  'payment.expired':
    '⌛ Your payment link expired: it stays valid for 2 hours. ' +
    'Tap the button below for a new one — if a place is still free.',
  'payment.retryButton': '🔄 New payment link',
  'payment.unavailable':
    'Online payment is temporarily unavailable. Please send /status again a bit later.',
  'status.notRegistered':
    'You are not registered yet. Send /start to register.',
  'status.pending':
    '⏳ Payment status: not paid yet.\nTap the button below to pay {amount} so‘m with Click.',
  'status.paid': '✅ Payment status: paid. Thank you!',
  'status.refund_requested':
    '↩️ Payment status: a refund has been requested and is being processed.',
  'status.refunded': '↩️ Payment status: refunded.',
  'status.expired':
    '⌛ Payment status: your invoice has expired. Please contact the organizers.',

  'qr.issued.JOB':
    '✅ Payment received — you are registered for Job & Edu Fair 2026!\n' +
    '🟢 Here is your Job Track (VIP) QR code. Show it at the entrance and to company HRs. ' +
    'Lost it? Send /status to get it again.',
  'qr.issued.EDU':
    '✅ Payment received — you are registered for Job & Edu Fair 2026!\n' +
    '🔵 Here is your Edu Track QR code. Show it at the entrance. ' +
    'Lost it? Send /status to get it again.',
  'qr.resend': '✅ Payment status: paid.\nHere is your {track} QR code again.',
  'qr.unavailable':
    '✅ Payment status: paid. We couldn’t send your QR code right now — please send /status again in a minute.',
} as const;

export type MessageKey = keyof typeof en;

const ru: Record<MessageKey, string> = {
  'language.name': 'Русский',
  'language.prompt': 'Пожалуйста, выберите язык:',

  'registration.welcome':
    'Добро пожаловать на Job & Edu Fair 2026! Давайте зарегистрируемся.',
  'registration.alreadyRegistered':
    'Вы уже зарегистрированы на Job & Edu Fair 2026. Отправьте /status, чтобы узнать статус оплаты.',
  'registration.closed': 'Извините, регистрация закрыта — все места заняты.',
  'registration.cancelled':
    'Регистрация отменена. Отправьте /start, чтобы начать заново.',
  'registration.sessionExpired':
    'Сессия истекла. Отправьте /start, чтобы зарегистрироваться заново.',
  'registration.invalid':
    'Некоторые ответы оказались некорректными. Отправьте /start, чтобы попробовать снова.',
  'registration.success':
    '✅ Вы зарегистрированы, {name}!\nТрек: {track}\n\n' +
    'Следующий шаг — оплата участия 50 000 сум.',

  'error.tryAgainLater':
    'Что-то пошло не так на нашей стороне. Попробуйте ещё раз через минуту.',
  'common.pickButton':
    'Пожалуйста, выберите один из вариантов на кнопках ниже.',

  'phone.button': '📱 Отправить номер телефона',
  'phone.prompt': 'Пожалуйста, отправьте свой номер телефона кнопкой ниже.',
  'phone.useButton': 'Пожалуйста, нажмите «{button}» ниже.',
  'phone.notOwn':
    'Пожалуйста, отправьте свой собственный номер телефона кнопкой ниже.',

  'fullName.prompt': 'Спасибо! Теперь отправьте имя и фамилию.',
  'fullName.invalid':
    'Пожалуйста, отправьте имя и фамилию, например «Азиз Каримов».',

  'birthYearOrCourse.prompt':
    'Год рождения или курс, если вы студент (например, «2003» или «3 курс»):',
  'birthYearOrCourse.invalid':
    'Пожалуйста, отправьте год рождения или курс текстом.',

  'direction.prompt': 'Выберите основное направление:',
  'direction.Frontend': 'Frontend',
  'direction.Backend': 'Backend',
  'direction.Mobile': 'Mobile',
  'direction.UI/UX': 'UI/UX',
  'direction.QA': 'QA',
  'direction.Data Science': 'Data Science',
  'direction.DevOps': 'DevOps',
  'direction.Other': 'Другое',

  'filter.prompt': 'Есть ли у вас уже IT-навык и портфолио или резюме?',
  'filter.yes': '✅ Да, есть навык + портфолио/резюме',
  'filter.no': '📚 Нет, я ещё учусь',

  'cvLink.prompt':
    'Отлично! Отправьте ссылку на резюме или портфолио (https://…).',
  'cvLink.invalid':
    'Это не похоже на ссылку. Отправьте полный адрес, например https://github.com/you',

  'track.JOB': 'Job Track',
  'track.EDU': 'Edu Track',

  'payment.offer':
    '💳 Стоимость участия: {amount} сум.\n' +
    'Нажмите кнопку ниже, чтобы оплатить через Click. Статус оплаты можно проверить в любой момент командой /status.',
  'payment.button': '💳 Оплатить {amount} сум через Click',
  'payment.expired':
    '⌛ Срок вашей ссылки на оплату истёк: она действует 2 часа. ' +
    'Нажмите кнопку ниже, чтобы получить новую, — если места ещё есть.',
  'payment.retryButton': '🔄 Новая ссылка на оплату',
  'payment.unavailable':
    'Онлайн-оплата временно недоступна. Пожалуйста, отправьте /status чуть позже.',
  'status.notRegistered':
    'Вы ещё не зарегистрированы. Отправьте /start, чтобы зарегистрироваться.',
  'status.pending':
    '⏳ Статус оплаты: не оплачено.\nНажмите кнопку ниже, чтобы оплатить {amount} сум через Click.',
  'status.paid': '✅ Статус оплаты: оплачено. Спасибо!',
  'status.refund_requested':
    '↩️ Статус оплаты: запрошен возврат, он обрабатывается.',
  'status.refunded': '↩️ Статус оплаты: средства возвращены.',
  'status.expired':
    '⌛ Статус оплаты: срок счёта истёк. Пожалуйста, свяжитесь с организаторами.',

  'qr.issued.JOB':
    '✅ Оплата получена — вы зарегистрированы на Job & Edu Fair 2026!\n' +
    '🟢 Вот ваш QR-код Job Track (VIP). Покажите его на входе и HR-специалистам компаний. ' +
    'Потеряли? Отправьте /status, чтобы получить его снова.',
  'qr.issued.EDU':
    '✅ Оплата получена — вы зарегистрированы на Job & Edu Fair 2026!\n' +
    '🔵 Вот ваш QR-код Edu Track. Покажите его на входе. ' +
    'Потеряли? Отправьте /status, чтобы получить его снова.',
  'qr.resend': '✅ Статус оплаты: оплачено.\nВот ваш QR-код {track} ещё раз.',
  'qr.unavailable':
    '✅ Статус оплаты: оплачено. Не удалось отправить QR-код прямо сейчас — пожалуйста, отправьте /status через минуту.',
};

const uz: Record<MessageKey, string> = {
  'language.name': "O'zbekcha",
  'language.prompt': 'Iltimos, tilni tanlang:',

  'registration.welcome':
    "Job & Edu Fair 2026 ga xush kelibsiz! Keling, ro'yxatdan o'tamiz.",
  'registration.alreadyRegistered':
    "Siz Job & Edu Fair 2026 ga allaqachon ro'yxatdan o'tgansiz. To'lov holatini bilish uchun /status yuboring.",
  'registration.closed':
    "Kechirasiz, ro'yxatdan o'tish yopildi — barcha joylar band.",
  'registration.cancelled':
    "Ro'yxatdan o'tish bekor qilindi. Qaytadan boshlash uchun /start yuboring.",
  'registration.sessionExpired':
    "Sessiya muddati tugadi. Qayta ro'yxatdan o'tish uchun /start yuboring.",
  'registration.invalid':
    "Ba'zi javoblaringiz noto'g'ri. Qaytadan urinish uchun /start yuboring.",
  'registration.success':
    "✅ Siz ro'yxatdan o'tdingiz, {name}!\nTrek: {track}\n\n" +
    "Keyingi qadam — 50 000 so'm ishtirok to'lovi.",

  'error.tryAgainLater':
    "Bizning tomonda xatolik yuz berdi. Iltimos, bir daqiqadan so'ng qayta urinib ko'ring.",
  'common.pickButton': 'Iltimos, quyidagi tugmalardan birini tanlang.',

  'phone.button': '📱 Telefon raqamni yuborish',
  'phone.prompt':
    'Iltimos, quyidagi tugma orqali telefon raqamingizni yuboring.',
  'phone.useButton': 'Iltimos, quyidagi «{button}» tugmasini bosing.',
  'phone.notOwn':
    "Iltimos, quyidagi tugma orqali o'zingizning telefon raqamingizni yuboring.",

  'fullName.prompt': 'Rahmat! Endi ism va familiyangizni yuboring.',
  'fullName.invalid':
    'Iltimos, ism va familiyangizni yuboring, masalan: «Aziz Karimov».',

  'birthYearOrCourse.prompt':
    "Tug'ilgan yilingiz yoki talaba bo'lsangiz, kursingiz (masalan, «2003» yoki «3-kurs»):",
  'birthYearOrCourse.invalid':
    "Iltimos, tug'ilgan yilingiz yoki kursingizni matn ko'rinishida yuboring.",

  'direction.prompt': "Asosiy yo'nalishingizni tanlang:",
  'direction.Frontend': 'Frontend',
  'direction.Backend': 'Backend',
  'direction.Mobile': 'Mobile',
  'direction.UI/UX': 'UI/UX',
  'direction.QA': 'QA',
  'direction.Data Science': 'Data Science',
  'direction.DevOps': 'DevOps',
  'direction.Other': 'Boshqa',

  'filter.prompt':
    "Sizda allaqachon IT ko'nikma va portfolio yoki rezyume bormi?",
  'filter.yes': "✅ Ha, ko'nikma + portfolio/rezyume bor",
  'filter.no': "📚 Yo'q, hali o'rganyapman",

  'cvLink.prompt':
    'Ajoyib! Rezyume yoki portfoliongizga havola yuboring (https://…).',
  'cvLink.invalid':
    "Bu havolaga o'xshamaydi. To'liq manzilni yuboring, masalan: https://github.com/you",

  'track.JOB': 'Job Track',
  'track.EDU': 'Edu Track',

  'payment.offer':
    "💳 Ishtirok to'lovi: {amount} so'm.\n" +
    "Click orqali to'lash uchun quyidagi tugmani bosing. To'lov holatini istalgan vaqtda /status orqali tekshirishingiz mumkin.",
  'payment.button': "💳 Click orqali {amount} so'm to'lash",
  'payment.expired':
    "⌛ To'lov havolangiz muddati tugadi: u 2 soat amal qiladi. " +
    "Yangisini olish uchun quyidagi tugmani bosing — agar bo'sh joy qolgan bo'lsa.",
  'payment.retryButton': "🔄 Yangi to'lov havolasi",
  'payment.unavailable':
    "Onlayn to'lov vaqtincha ishlamayapti. Iltimos, birozdan so'ng /status ni qayta yuboring.",
  'status.notRegistered':
    "Siz hali ro'yxatdan o'tmagansiz. Ro'yxatdan o'tish uchun /start yuboring.",
  'status.pending':
    "⏳ To'lov holati: to'lanmagan.\nClick orqali {amount} so'm to'lash uchun quyidagi tugmani bosing.",
  'status.paid': "✅ To'lov holati: to'langan. Rahmat!",
  'status.refund_requested':
    "↩️ To'lov holati: pulni qaytarish so'raldi, ko'rib chiqilmoqda.",
  'status.refunded': "↩️ To'lov holati: pul qaytarildi.",
  'status.expired':
    "⌛ To'lov holati: hisob muddati tugagan. Iltimos, tashkilotchilarga murojaat qiling.",

  'qr.issued.JOB':
    "✅ To'lov qabul qilindi — siz Job & Edu Fair 2026 ga ro'yxatdan o'tdingiz!\n" +
    "🟢 Mana Job Track (VIP) QR-kodingiz. Uni kirishda va kompaniyalar HR xodimlariga ko'rsating. " +
    "Yo'qotib qo'ysangiz, qayta olish uchun /status yuboring.",
  'qr.issued.EDU':
    "✅ To'lov qabul qilindi — siz Job & Edu Fair 2026 ga ro'yxatdan o'tdingiz!\n" +
    "🔵 Mana Edu Track QR-kodingiz. Uni kirishda ko'rsating. " +
    "Yo'qotib qo'ysangiz, qayta olish uchun /status yuboring.",
  'qr.resend':
    "✅ To'lov holati: to'langan.\nMana {track} QR-kodingiz yana bir bor.",
  'qr.unavailable':
    "✅ To'lov holati: to'langan. QR-kodni hozir yuborib bo'lmadi — iltimos, bir daqiqadan so'ng /status ni qayta yuboring.",
};

export const translations: Record<Lang, Record<MessageKey, string>> = {
  uz,
  ru,
  en,
};
