// Generated from src/data/applicationForms.ts (enrolSections) by toPdfSections; scripts/test-azure-provider.ts fails when this drifts.
// Labels, types, conditions and the checkbox / declaration texts only: option lists, scans and descriptions are not needed for the PDF.
import type { PdfSection } from "./pdf-form.ts";

export const PDF_FORM_SECTIONS: PdfSection[] = [
 {
  "title": "Personal details & passport",
  "fields": [
   {
    "name": "passport_copy",
    "label": "Passport Attachment (Biodata Page)",
    "type": "file"
   },
   {
    "name": "title",
    "label": "Title",
    "type": "select"
   },
   {
    "name": "first_name",
    "label": "Given Name",
    "type": "text"
   },
   {
    "name": "middle_name",
    "label": "Middle Name (If Applicable)",
    "type": "text"
   },
   {
    "name": "last_name",
    "label": "Surname",
    "type": "text"
   },
   {
    "name": "dob",
    "label": "Date of Birth",
    "type": "date"
   },
   {
    "name": "gender",
    "label": "Gender",
    "type": "radio"
   },
   {
    "name": "mobile",
    "label": "Mobile",
    "type": "tel",
    "format": "phone"
   },
   {
    "name": "email",
    "label": "Email",
    "type": "email"
   },
   {
    "name": "confirm_email",
    "label": "Confirm Email",
    "type": "email"
   },
   {
    "name": "email_note",
    "label": "",
    "type": "static"
   },
   {
    "name": "citizenship",
    "label": "Country of Citizenship",
    "type": "select"
   },
   {
    "name": "nationality",
    "label": "Nationality",
    "type": "select"
   },
   {
    "name": "birth_country",
    "label": "Country of Birth",
    "type": "select"
   },
   {
    "name": "passport_number",
    "label": "Passport Number",
    "type": "text"
   },
   {
    "name": "passport_expiry",
    "label": "Passport Expiry Date",
    "type": "date"
   }
  ]
 },
 {
  "title": "Address",
  "fields": [
   {
    "name": "address_type",
    "label": "Address Type",
    "type": "radio"
   },
   {
    "name": "au_street",
    "label": "Street Address",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Australian Address"
     ]
    }
   },
   {
    "name": "au_line2",
    "label": "Address Line 2",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Australian Address"
     ]
    }
   },
   {
    "name": "au_suburb",
    "label": "Suburb",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Australian Address"
     ]
    }
   },
   {
    "name": "au_state",
    "label": "State",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Australian Address"
     ]
    }
   },
   {
    "name": "au_zip",
    "label": "ZIP / Postal Code",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Australian Address"
     ]
    }
   },
   {
    "name": "au_country",
    "label": "Country",
    "type": "select",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Australian Address"
     ]
    }
   },
   {
    "name": "ov_street",
    "label": "Address",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Overseas Address"
     ]
    }
   },
   {
    "name": "ov_line2",
    "label": "Address Line 2",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Overseas Address"
     ]
    }
   },
   {
    "name": "ov_suburb",
    "label": "Suburb",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Overseas Address"
     ]
    }
   },
   {
    "name": "ov_state",
    "label": "State / Territory",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Overseas Address"
     ]
    }
   },
   {
    "name": "ov_zip",
    "label": "ZIP / Postal Code",
    "type": "text",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Overseas Address"
     ]
    }
   },
   {
    "name": "ov_country",
    "label": "Country",
    "type": "select",
    "showIf": {
     "field": "address_type",
     "equals": [
      "Overseas Address"
     ]
    }
   },
   {
    "name": "address_note",
    "label": "",
    "type": "static"
   }
  ]
 },
 {
  "title": "Visa, english & agent details",
  "fields": [
   {
    "name": "holds_visa",
    "label": "Do you currently hold a valid Australian visa?",
    "type": "radio"
   },
   {
    "name": "visa_copy",
    "label": "Visa Documents",
    "type": "file",
    "showIf": {
     "field": "holds_visa",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "visa_subclass",
    "label": "Visa Subclass",
    "type": "text",
    "showIf": {
     "field": "holds_visa",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "visa_grant_date",
    "label": "Visa Grant Date",
    "type": "date",
    "showIf": {
     "field": "holds_visa",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "visa_stay_until",
    "label": "Visa Stay-until / Expiry Date",
    "type": "date",
    "showIf": {
     "field": "holds_visa",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "visa_grant_number",
    "label": "Visa Grant Number",
    "type": "text",
    "showIf": {
     "field": "holds_visa",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "english_type",
    "label": "English Assessment Type",
    "type": "select"
   },
   {
    "name": "english_score",
    "label": "Score (Individual & Overall)",
    "type": "text"
   },
   {
    "name": "english_table",
    "label": "English Score Requirements (Reference)",
    "type": "table"
   },
   {
    "name": "english_date",
    "label": "Date Achieved",
    "type": "date"
   },
   {
    "name": "english_upload",
    "label": "Upload English Results",
    "type": "file"
   },
   {
    "name": "via_agent",
    "label": "Is your application submitted through an agent?",
    "type": "radio"
   },
   {
    "name": "agent_agency",
    "label": "Agent / Agency Name",
    "type": "select",
    "showIf": {
     "field": "via_agent",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "agent_contact_name",
    "label": "Agent Contact Person",
    "type": "text",
    "showIf": {
     "field": "via_agent",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "agent_email",
    "label": "Agent Email",
    "type": "email",
    "showIf": {
     "field": "via_agent",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "agent_phone",
    "label": "Agent Contact Number",
    "type": "tel",
    "format": "phone",
    "showIf": {
     "field": "via_agent",
     "equals": [
      "Yes"
     ]
    }
   }
  ]
 },
 {
  "title": "Student identifier (avetmiss)",
  "fields": [
   {
    "name": "atsi",
    "label": "Are you of Aboriginal or Torres Strait Islander origin?",
    "type": "radio"
   },
   {
    "name": "employment",
    "label": "Employment Status",
    "type": "select"
   },
   {
    "name": "language_home",
    "label": "Language Spoken at Home",
    "type": "select"
   },
   {
    "name": "secondary_enrolled",
    "label": "Are you still enrolled in secondary or senior secondary education?",
    "type": "radio"
   },
   {
    "name": "school_level",
    "label": "Highest Completed School Level",
    "type": "select"
   },
   {
    "name": "year_completed",
    "label": "Year Completed",
    "type": "text"
   },
   {
    "name": "prior_ed",
    "label": "Have you successfully completed any prior education?",
    "type": "radio"
   },
   {
    "name": "disability",
    "label": "Do you have any disability that may affect your participation in the course?",
    "type": "radio"
   }
  ]
 },
 {
  "title": "Academic documents",
  "fields": [
   {
    "name": "academic_upload",
    "label": "Academic Records and Qualifications",
    "type": "file"
   },
   {
    "name": "academic_institution",
    "label": "Institution / School",
    "type": "text"
   },
   {
    "name": "academic_qualification",
    "label": "Qualification / Award",
    "type": "text"
   },
   {
    "name": "academic_year",
    "label": "Year Completed",
    "type": "select",
    "format": "year"
   }
  ]
 },
 {
  "title": "Unique student identifier (usi)",
  "fields": [
   {
    "name": "usi_note",
    "label": "",
    "type": "static"
   },
   {
    "name": "has_usi",
    "label": "Do you already have a USI?",
    "type": "radio"
   },
   {
    "name": "usi_number",
    "label": "USI Number",
    "type": "text",
    "format": "usi",
    "showIf": {
     "field": "has_usi",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "usi_consent",
    "label": "USI Consent",
    "type": "checkbox",
    "options": [
     "I consent to SLIT using/providing my USI for enrolment, reporting and verification purposes where required."
    ]
   }
  ]
 },
 {
  "title": "Emergency contact",
  "fields": [
   {
    "name": "ec_name",
    "label": "Full Name",
    "type": "text"
   },
   {
    "name": "ec_relationship",
    "label": "Relationship to You",
    "type": "text"
   },
   {
    "name": "ec_email",
    "label": "Email",
    "type": "email"
   },
   {
    "name": "ec_phone",
    "label": "Contact Number",
    "type": "tel",
    "format": "phone"
   },
   {
    "name": "ec_in_au",
    "label": "Is your emergency contact in Australia?",
    "type": "radio"
   },
   {
    "name": "ec_street",
    "label": "Emergency Contact Street Address",
    "type": "text"
   },
   {
    "name": "ec_line2",
    "label": "Address Line 2",
    "type": "text"
   },
   {
    "name": "ec_suburb",
    "label": "Suburb",
    "type": "text"
   },
   {
    "name": "ec_state",
    "label": "State / Province / Region",
    "type": "text"
   },
   {
    "name": "ec_zip",
    "label": "ZIP / Postal Code",
    "type": "text"
   },
   {
    "name": "ec_country",
    "label": "Country",
    "type": "select"
   }
  ]
 },
 {
  "title": "Course information",
  "fields": [
   {
    "name": "courses_of_interest",
    "label": "Course Name (Course Code and Title)",
    "type": "checkbox"
   },
   {
    "name": "preferred_intake",
    "label": "Preferred Intake",
    "type": "text"
   },
   {
    "name": "intake_note",
    "label": "",
    "type": "static"
   }
  ]
 },
 {
  "title": "Study reason",
  "fields": [
   {
    "name": "study_reason",
    "label": "Main reason for undertaking this course",
    "type": "radio"
   }
  ]
 },
 {
  "title": "Course credit",
  "fields": [
   {
    "name": "rpl",
    "label": "Do you wish to apply for Recognition of Prior Learning (RPL) / Credit Transfer (CT)?",
    "type": "radio"
   },
   {
    "name": "credit_upload",
    "label": "Upload Supporting Documents for RPL / Credit Transfer",
    "type": "file",
    "showIf": {
     "field": "rpl",
     "equals": [
      "Yes"
     ]
    }
   }
  ]
 },
 {
  "title": "Oshc / health insurance",
  "fields": [
   {
    "name": "oshc_docs",
    "label": "Health Insurance Documents",
    "type": "file"
   },
   {
    "name": "oshc_require",
    "label": "Do you require SLIT to obtain Overseas Student Health Cover on your behalf?",
    "type": "select"
   },
   {
    "name": "oshc_start_date",
    "label": "Preferred OSHC Cover Start Date",
    "type": "date",
    "showIf": {
     "field": "oshc_require",
     "equals": [
      "Yes"
     ]
    }
   },
   {
    "name": "oshc_self_confirm",
    "label": "OSHC Confirmation",
    "type": "checkbox",
    "showIf": {
     "field": "oshc_require",
     "equals": [
      "No"
     ]
    },
    "options": [
     "I understand I must arrange and maintain my own Overseas Student Health Cover for the full duration of my student visa and provide proof when requested."
    ]
   },
   {
    "name": "oshc_provider",
    "label": "OSHC Provider",
    "type": "text",
    "showIf": {
     "field": "oshc_require",
     "equals": [
      "Already Have"
     ]
    }
   },
   {
    "name": "oshc_policy_number",
    "label": "Policy / Membership Number",
    "type": "text",
    "showIf": {
     "field": "oshc_require",
     "equals": [
      "Already Have"
     ]
    }
   },
   {
    "name": "oshc_expiry",
    "label": "Policy Expiry Date",
    "type": "date",
    "showIf": {
     "field": "oshc_require",
     "equals": [
      "Already Have"
     ]
    }
   }
  ]
 },
 {
  "title": "How did you hear about slit?",
  "fields": [
   {
    "name": "hear_about",
    "label": "Source",
    "type": "select"
   }
  ]
 },
 {
  "title": "Application checklist",
  "fields": [
   {
    "name": "checklist_note",
    "label": "",
    "type": "static"
   },
   {
    "name": "checklist",
    "label": "Application Checklist",
    "type": "checkbox",
    "options": [
     "Complete all sections of the application form",
     "Provide details if you already have a student visa and/or OSHC"
    ]
   }
  ]
 },
 {
  "title": "Student declaration",
  "fields": [
   {
    "name": "declaration",
    "label": "By submitting this 'Student Application for Enrolment' the applicant acknowledges the following:",
    "type": "terms",
    "options": [
     "I declare that the information submitted with this application is true and complete.",
     "I acknowledge that failure to provide any document or disclose my academic record may result in SLIT revoking an offer or terminating my studies at any stage.",
     "I authorise SLIT to seek verification of my academic and professional qualifications, and work experience. I understand that SLIT reserves the right to inform other tertiary institutions and regulatory agencies and right to cancel the enrolment if any of the material presented to support my application is found to be false",
     "I understand that at the time of enrolment I will be required to supply originals of all documents used to support this application",
     "I acknowledge that SLIT reserves the right to alter any course, subject, admission requirement or fee without prior notice.",
     "I understand that the personal information I have provided may be released to government agencies as required by law.",
     "I further understand that it may be disclosed to third parties for the purpose of this application. I also undertake to update about any address / contact detail change within 5 working days in writing to the college.",
     "I acknowledge that I have read and understand the description of the courses(s) that I am applying for.",
     "I agree to pay the applicable tuition fees prior to COE Issuance, term commencement and subsequent instalments of nominated studies set out on the letter of offer and I agree to be personally liable to the debt arising from fees owing. I understand that SLIT may seek the services of external debt collection agencies for the collection purpose. I will be liable to pay for any legal or linked charges for any such agencies",
     "I have read and understand SLIT fees and refund policy and requirements as set out within the Student Handbook.",
     "I authorised SLIT to access the Australian immigration Visa Entitlements Verification Online (VEVO) system at any time to obtain information on my visa status.",
     "I declare that I am a genuine temporary entrant and genuine student and that I have read and understood conditions relating to requirements outlined on https://www.homeaffairs.gov.au",
     "I am aware of the tuition and living costs of my stay in Australia and have the financial capacity to meet such costs for the duration of my course. I will make timely payments of any fees or associated costs.",
     "I have read and understand the description of the ESOS framework made available at: https://internationaleducation.gov.au/regulatory-information/pages/regulatoryinformation.aspx",
     "I declare that the information provided in this application and the documentation supporting it is true and complete"
    ]
   },
   {
    "name": "declaration_name",
    "label": "Full Name of The Person Who Made the Declaration",
    "type": "text"
   },
   {
    "name": "digital_signature",
    "label": "Digital Signature",
    "type": "text"
   },
   {
    "name": "declaration_date",
    "label": "Declaration Date",
    "type": "date"
   }
  ]
 }
];
