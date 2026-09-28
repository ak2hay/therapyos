export interface TemplateService {
  name: string;
  durationMinutes: number;
  basePrice: number;
  description?: string;
}
export interface TemplateCategory {
  name: string;
  services: TemplateService[];
}

const MASSAGE: TemplateCategory[] = [
  {
    name: 'Massage',
    services: [
      { name: 'Swedish Massage', durationMinutes: 60, basePrice: 1800 },
      { name: 'Deep Tissue Massage', durationMinutes: 60, basePrice: 2200 },
      { name: 'Aromatherapy Massage', durationMinutes: 60, basePrice: 2000 },
      { name: 'Hot Stone Massage', durationMinutes: 75, basePrice: 2800 },
      { name: 'Head, Neck & Shoulder', durationMinutes: 30, basePrice: 900 },
    ],
  },
  {
    name: 'Body Care',
    services: [
      { name: 'Body Scrub', durationMinutes: 45, basePrice: 1500 },
      { name: 'Body Wrap', durationMinutes: 60, basePrice: 2200 },
    ],
  },
];

const AYURVEDA: TemplateCategory[] = [
  {
    name: 'Ayurvedic Therapies',
    services: [
      { name: 'Abhyanga', durationMinutes: 60, basePrice: 2000, description: 'Full body warm oil massage' },
      { name: 'Shirodhara', durationMinutes: 45, basePrice: 2500, description: 'Continuous oil flow on the forehead' },
      { name: 'Kizhi (Potli)', durationMinutes: 60, basePrice: 2400 },
      { name: 'Udvartana', durationMinutes: 60, basePrice: 2200, description: 'Herbal powder massage' },
      { name: 'Nasyam', durationMinutes: 30, basePrice: 1200 },
    ],
  },
  {
    name: 'Panchakarma',
    services: [
      { name: 'Panchakarma Consultation', durationMinutes: 30, basePrice: 800 },
      { name: 'Kati Basti', durationMinutes: 45, basePrice: 1800 },
      { name: 'Janu Basti', durationMinutes: 45, basePrice: 1800 },
    ],
  },
];

const PHYSIO: TemplateCategory[] = [
  {
    name: 'Physiotherapy',
    services: [
      { name: 'Initial Assessment', durationMinutes: 45, basePrice: 1000 },
      { name: 'Follow-up Session', durationMinutes: 30, basePrice: 700 },
      { name: 'Sports Injury Rehab', durationMinutes: 45, basePrice: 1200 },
      { name: 'Post-Surgery Rehab', durationMinutes: 45, basePrice: 1200 },
      { name: 'Dry Needling', durationMinutes: 30, basePrice: 1500 },
    ],
  },
  {
    name: 'Electrotherapy',
    services: [
      { name: 'TENS / IFT', durationMinutes: 20, basePrice: 400 },
      { name: 'Ultrasound Therapy', durationMinutes: 15, basePrice: 400 },
    ],
  },
];

const FOOT: TemplateCategory[] = [
  {
    name: 'Foot Therapy',
    services: [
      { name: 'Foot Reflexology', durationMinutes: 45, basePrice: 1000 },
      { name: 'Foot Massage', durationMinutes: 30, basePrice: 700 },
      { name: 'Foot Spa', durationMinutes: 45, basePrice: 900 },
      { name: 'Reflexology + Head Massage', durationMinutes: 60, basePrice: 1400 },
    ],
  },
];

const WELLNESS: TemplateCategory[] = [
  ...MASSAGE.slice(0, 1),
  {
    name: 'Wellness',
    services: [
      { name: 'Foot Reflexology', durationMinutes: 45, basePrice: 1000 },
      { name: 'Facial', durationMinutes: 60, basePrice: 1800 },
      { name: 'Steam Bath', durationMinutes: 20, basePrice: 500 },
      { name: 'Couple Massage', durationMinutes: 60, basePrice: 3800 },
    ],
  },
];

const ALTERNATIVE: TemplateCategory[] = [
  {
    name: 'Alternative Therapy',
    services: [
      { name: 'Acupressure', durationMinutes: 45, basePrice: 1200 },
      { name: 'Cupping Therapy', durationMinutes: 45, basePrice: 1500 },
      { name: 'Reiki Healing', durationMinutes: 45, basePrice: 1500 },
      { name: 'Sound Healing', durationMinutes: 60, basePrice: 1800 },
    ],
  },
];

const OTHER: TemplateCategory[] = [
  {
    name: 'General',
    services: [
      { name: 'Consultation', durationMinutes: 30, basePrice: 500 },
      { name: 'Therapy Session (60 min)', durationMinutes: 60, basePrice: 1500 },
    ],
  },
];

/** Business type only seeds sensible defaults; tenants can edit or remove everything afterwards. */
export const BUSINESS_TEMPLATES: Record<string, TemplateCategory[]> = {
  MASSAGE,
  AYURVEDA,
  WELLNESS,
  PHYSIOTHERAPY: PHYSIO,
  FOOT_THERAPY: FOOT,
  ALTERNATIVE_THERAPY: ALTERNATIVE,
  OTHER,
};

/** Suggested default settings per business type (applied during onboarding). */
export const BUSINESS_DEFAULTS: Record<string, Record<string, unknown>> = {
  PHYSIOTHERAPY: { DEFAULT_APPOINTMENT_DURATION: 45, APPOINTMENT_BUFFER: 5 },
  FOOT_THERAPY: { DEFAULT_APPOINTMENT_DURATION: 45, APPOINTMENT_BUFFER: 5 },
  AYURVEDA: { DEFAULT_APPOINTMENT_DURATION: 60, APPOINTMENT_BUFFER: 15 },
};

export const SERVICE_COLORS = ['#0d9488', '#7c3aed', '#db2777', '#ea580c', '#2563eb', '#16a34a', '#ca8a04', '#0891b2'];
