// Medical vocabulary for speech recognition.
//   MEDICAL_PHRASES  phrase hints sent to Chirp 2 (speech adaptation): drug names, Canadian brands, women's-health and symptom words that
//                    general speech models mishear ("calf" -> "class", "ankles" -> "uncle", "Estrogel" -> "Proscestra gel").
//   MEDICAL_TERMS    the same words as single lowercase tokens, used to check what two engines heard (see consensus.js).
// Built from the drug and brand names in this clinic's own gold notes (2,801 Canadian family-practice notes) plus common clinical words. It only
// BIASES recognition toward these words (a boost, not a replacement), so a word that is not here is still transcribed as heard.
'use strict';

const GENERICS = `acetaminophen acyclovir adalimumab albuterol alendronate allopurinol almotriptan amitriptyline amlodipine amoxicillin ampicillin anastrozole apixaban aripiprazole
atenolol atomoxetine atorvastatin azathioprine azithromycin baclofen beclomethasone betamethasone bisoprolol budesonide bupivacaine bupropion candesartan captopril carvedilol cefuroxime celecoxib
cephalexin cetirizine chlorthalidone ciprofloxacin citalopram clarithromycin clindamycin clobazam clonazepam clonidine clopidogrel clotrimazole codeine colchicine cyanocobalamin cyclobenzaprine
dapagliflozin denosumab desvenlafaxine dexamethasone diazepam diclofenac digoxin diltiazem diphenhydramine domperidone doxycycline dulaglutide duloxetine empagliflozin enalapril erythromycin
escitalopram esomeprazole estradiol ethinyl ezetimibe famotidine fenofibrate fexofenadine finasteride fluconazole fluoxetine fluticasone folic fosfomycin furosemide gabapentin gliclazide glyburide
guanfacine heparin hydralazine hydrochlorothiazide hydrocortisone hydromorphone hydroxychloroquine ibuprofen indapamide infliximab insulin ipratropium irbesartan ketoconazole ketoprofen
lamotrigine lansoprazole letrozole levofloxacin levonorgestrel levothyroxine lidocaine linagliptin liraglutide lisinopril lisdexamfetamine lithium loperamide loratadine lorazepam losartan
lovastatin medroxyprogesterone melatonin metformin methimazole methocarbamol methotrexate methylphenidate metoprolol metronidazole minocycline mirabegron mirtazapine mometasone montelukast
morphine moxifloxacin mupirocin nadolol naproxen nifedipine nitrofurantoin nitroglycerin norfloxacin nortriptyline nystatin olmesartan omeprazole ondansetron oseltamivir oxazepam oxybutynin
oxycodone pantoprazole paroxetine penicillin perindopril pravastatin prednisolone prednisone pregabalin progesterone propranolol quetiapine quinapril rabeprazole ramipril ranitidine risedronate
risperidone rivaroxaban rizatriptan rosuvastatin salbutamol semaglutide sertraline sildenafil simvastatin sitagliptin solifenacin spironolactone sumatriptan tadalafil tamoxifen tamsulosin
telmisartan temazepam terbinafine testosterone tetracycline tiotropium tirzepatide tizanidine tobramycin topiramate torsemide tramadol trazodone triamcinolone trimethoprim valacyclovir valsartan
venlafaxine verapamil warfarin zopiclone`.split(/\s+/);

const BRANDS = `Abilify Actonel Adacel Advair Advil Aerius Aldactone Aleve Altace Ativan Atacand Augmentin Bactroban Benadryl Boniferro Boniva Boostrix Botox Celebrex Cipralex Claritin Clavulin Climara Colace
Concerta Contrave Coversyl Cozaar Crestor Cymbalta Dexilant Diovan Dymista Eliquis Eltroxin Entresto Estrace Estrogel Estring Effexor Fosamax Flonase Flovent Forxiga Fucidin Gardasil Glucophage
Gravol Imodium Imovane Januvia Jardiance Lasix Libre Lipitor Losec Lyrica Metamucil Micardis Mirena Mounjaro Motrin Nasonex Neurontin Nexium Nizoral Norvasc Omnaris Ozempic Pantoloc Pepcid
Plavix Prevnar Prolia Prometrium Provera Pulmicort Reactine Rexulti Rivotril Rybelsus Ryaltris Seroquel Senokot Shingrix Spiriva Symbicort Synjardy Synthroid Trajenta Trintellix Tylenol Tums
Ventolin Victoza Vagifem Voltaren Vyvanse Wegovy Wellbutrin Xanax Xarelto Zepbound Zocor Zoloft Zyrtec`.split(/\s+/);

// Words general speech models confuse with everyday words, grouped for the clinic (anatomy, symptoms, women's health, tests, conditions).
const CLINICAL = `calf calves ankle ankles shin shins thigh thighs groin flank abdomen epigastric sternum clavicle collarbone scapula Achilles knee knees elbow wrist hamstring quadriceps
swelling swollen edema tenderness palpitations lightheadedness lightheaded dizziness vertigo syncope dyspnea orthopnea wheezing sputum hemoptysis hematuria dysuria nocturia polyuria incontinence
nausea vomiting bloating constipation diarrhea heartburn reflux indigestion
perimenopause menopause menopausal amenorrhea dysmenorrhea menorrhagia spotting fibroids endometriosis ovarian uterine cervical vaginal hysterectomy hormone estrogen
mammogram colonoscopy ultrasound echocardiogram spirometry Holter electrocardiogram ECG EKG MRI A1C HbA1c TSH ferritin hemoglobin creatinine eGFR triglycerides cholesterol LDL HDL PSA INR
hypertension hypotension hypothyroidism hyperthyroidism prediabetes diabetes osteoporosis osteopenia anemia hyperlipidemia dyslipidemia tachycardia bradycardia arrhythmia fibrillation angina
cellulitis eczema psoriasis rosacea dermatitis urticaria melanoma cryotherapy biopsy lesion rash
bronchitis pneumonia asthma COPD sinusitis otitis tonsillitis conjunctivitis tinnitus migraine neuralgia neuropathy sciatica radiculopathy tendinitis bursitis fasciitis arthritis gout fibromyalgia
anxiety depression insomnia ADHD apnea thrombosis embolism thrombophlebitis varicose claudication
sulfa codeine statin inhaler puffer nebulizer patch gel capsule suppository ointment`.split(/\s+/);

const PHRASES = [
  ...GENERICS.map((v) => ({ value: v, boost: 10 })),
  ...BRANDS.map((v) => ({ value: v, boost: 10 })),
  ...CLINICAL.map((v) => ({ value: v, boost: 7 })),
  ...['deep vein thrombosis', 'pulmonary embolism', 'blood clot', 'calf pain', 'calf tenderness', 'shortness of breath', 'chest pain', 'hot flashes', 'night sweats', 'Pap smear', 'FIT test',
    'blood pressure', 'heart rate', 'bloodwork', 'water retention', 'side effects', 'birth control', 'hormone replacement therapy', 'vitamin D', 'vitamin B12', 'folic acid', 'estradiol gel',
    'Estrogel', 'Prometrium capsule', 'testosterone cream'].map((v) => ({ value: v, boost: 8 })),
];

/** Unique phrases, never more than `max` (speech adaptation accepts a few hundred inline phrases comfortably). */
export function medicalPhrases({ max = 700, boost } = {}) {
  const seen = new Set(); const out = [];
  for (const p of PHRASES) { const k = p.value.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(boost ? { value: p.value, boost } : p); if (out.length >= max) break; }
  return out;
}
export const MEDICAL_TERMS = new Set(PHRASES.flatMap((p) => p.value.toLowerCase().split(/\s+/)).filter((w) => w.length >= 4));
