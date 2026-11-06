/**
 * The real public figures in the Gillings workspace (see `gillings.ts`): UNC and Gillings
 * faculty and leaders, Research Triangle leaders, and global health leaders.
 *
 * Roles and photos were checked against official pages and Wikimedia Commons in October 2026
 * (every photo URL answered 200 with an image type). Touches are public settings only — a
 * lecture, a town hall, office hours, a keynote or livestream — never a private conversation,
 * and no email or LinkedIn URL is stored, so nothing can be sent and no lookup runs.
 *
 * Pure data, generated from the verified roster; edit by hand from here on.
 */
import type { DemoPerson } from "@/lib/demo-data/network";

export type RealPerson = {
  person: DemoPerson;
  photoUrl: string;
  sourceUrl: string;
};

export const GILLINGS_REAL_PEOPLE: RealPerson[] = [
  {
    person: {
      fullName: "Nancy Messonnier",
      firstName: "Nancy",
      lastName: "Messonnier",
      title: "Dean and Bryson Distinguished Professor in Public Health",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 2,
      howMet: "Dean's town hall at Gillings",
      metDaysAgo: 40,
      keyFacts: [
        "Dean of the Gillings School since fall 2022",
        "Former director of CDC's National Center for Immunization and Respiratory Diseases; led early COVID-19 response briefings",
      ],
      tags: ["Gillings faculty"],
      touches: [
        {
          at: 40,
          type: "event",
          notes:
            "Dean's town hall. Asked Dean Messonnier how undergraduates can get involved in pandemic preparedness; she pointed to the school's practicum network and the alumni mentoring program.",
        },
      ],
      standing:
        "Public figure. Her town hall answer is why you joined the alumni mentoring program.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Dean and Bryson Distinguished Professor in Public Health",
          2020,
          null,
        ],
      ],
      education: [
        ["University of Pennsylvania", "BA", 1990, 1994],
        [
          "University of Chicago Pritzker School of Medicine",
          "Medicine (MD)",
          1990,
          1994,
        ],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2025/10/nancy_messonnier_2025_738x714_favorite.png",
    sourceUrl: "https://sph.unc.edu/adv_profile/nancy-messonnier-md/",
  },
  {
    person: {
      fullName: "Barbara K. Rimer",
      firstName: "Barbara",
      lastName: "Rimer",
      title: "Dean Emerita and Alumni Distinguished Professor Emerita",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "Guest lecture in Intro to Public Health",
      metDaysAgo: 400,
      keyFacts: [
        "First woman and behavioral scientist to chair the National Cancer Institute's National Cancer Advisory Board",
        "Research on cancer screening and informed decision making; 270+ peer-reviewed articles",
      ],
      tags: ["Gillings faculty"],
      touches: [
        {
          at: 400,
          type: "event",
          notes:
            "Guest lecture on cancer prevention and communication research. Noted her line about evidence only mattering once it reaches people.",
        },
      ],
      standing: "Public figure. Heard her guest lecture in first year.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Dean Emerita and Alumni Distinguished Professor Emerita",
          2020,
          null,
        ],
      ],
      education: [
        ["University of Michigan", "English (BA)", 1966, 1970],
        ["University of Michigan", "Health Education (MPH)", 1971, 1973],
        ["Johns Hopkins University", "Health Education (DrPH)", 1977, 1981],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2015/09/rimer-barbara-2020-738x714-1-738x714.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/barbara-k-rimer-drph/",
  },
  {
    person: {
      fullName: "Kristin Reiter",
      firstName: "Kristin",
      lastName: "Reiter",
      title:
        "Humana Distinguished Professor and Chair, Department of Health Policy and Management",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 2,
      howMet: "HPM department welcome event",
      metDaysAgo: 380,
      keyFacts: [
        "Chair of Health Policy and Management since Oct 2023",
        "Research on rural hospital finance; Research Fellow at the Cecil G. Sheps Center",
      ],
      tags: ["Gillings faculty", "HPM"],
      touches: [
        {
          at: 380,
          type: "event",
          notes:
            "HPM welcome event for new majors. She described the department's focus on rural health systems.",
        },
        {
          at: 60,
          type: "event",
          notes:
            "HPM seminar on rural hospital finances — directly relevant to the Sheps project.",
        },
      ],
      standing:
        "Department chair. Her rural hospital finance seminar overlaps your Sheps work.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Humana Distinguished Professor and Chair, Department of Health Policy and Management",
          2020,
          null,
        ],
      ],
      education: [
        ["Northern Illinois University", "Accounting (BS)", 1989, 1993],
        ["University of Michigan", "Applied Economics (MAE)", 1998, 2000],
        [
          "University of Michigan",
          "Health Services Organization and Policy (PhD)",
          1999,
          2004,
        ],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2025/10/kristin-reiter_2025_738x714.png",
    sourceUrl: "https://sph.unc.edu/adv_profile/kristin-reiter-phd/",
  },
  {
    person: {
      fullName: "Kristen Hassmiller Lich",
      firstName: "Kristen",
      lastName: "Hassmiller Lich",
      title: "Professor, Department of Health Policy and Management",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 2,
      howMet: "Systems thinking lecture in HPM",
      metDaysAgo: 70,
      keyFacts: [
        "Applies systems science and simulation modeling to health policy decisions",
        "Honored with a 2025 Gillings community award for mentorship, teaching, research and service",
      ],
      tags: ["Gillings faculty", "HPM"],
      touches: [
        {
          at: 70,
          type: "event",
          notes:
            "Lecture on systems thinking for health policy. Loved the causal loop diagrams.",
        },
        {
          at: 35,
          type: "in_person",
          notes:
            "Office hours. Asked how systems modeling could apply to rural OB closures; she suggested reading the group model building papers.",
        },
      ],
      standing:
        "Met at office hours. She suggested group model building readings.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Professor, Department of Health Policy and Management",
          2020,
          null,
        ],
      ],
      education: [
        ["University of Akron", "Psychology and Gerontology (BS)", 1992, 1996],
        ["University of Michigan", "Public Health (MHA)", 1998, 2000],
        [
          "University of Michigan",
          "Health Services Organization and Policy (PhD)",
          2001,
          2007,
        ],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2016/01/hassmiller-lich_kristen_738x714-738x714.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/kristen-hassmiller-lich-phd/",
  },
  {
    person: {
      fullName: "Ralph S. Baric",
      firstName: "Ralph",
      lastName: "Baric",
      title:
        "William R. Kenan, Jr. Distinguished Professor, Department of Epidemiology",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "Gillings research symposium keynote",
      metDaysAgo: 95,
      keyFacts: [
        "World leader in coronavirus research for more than three decades",
        "Also Professor of Microbiology and Immunology, UNC School of Medicine",
      ],
      tags: ["Gillings faculty"],
      touches: [
        {
          at: 95,
          type: "event",
          notes:
            "Research symposium keynote on coronavirus research and pandemic preparedness.",
        },
      ],
      standing: "Public figure. Heard his symposium keynote.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "William R. Kenan, Jr. Distinguished Professor, Department of Epidemiology",
          2020,
          null,
        ],
      ],
      education: [
        ["North Carolina State University", "Zoology (BS)", 1973, 1977],
        ["North Carolina State University", "Microbiology (PhD)", 1977, 1982],
        [
          "University of Southern California",
          "Microbiology (Postdoctoral Fellowship)",
          1982,
          1986,
        ],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2021/10/Ralph_Baric_2021_Jon_Gardiner_738x714-738x714.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/ralph-s-baric-phd/",
  },
  {
    person: {
      fullName: "Audrey Pettifor",
      firstName: "Audrey",
      lastName: "Pettifor",
      title: "Professor and Associate Chair, Department of Epidemiology",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "Global health research seminar",
      metDaysAgo: 150,
      keyFacts: [
        "Social epidemiologist focused on HIV prevention among adolescents and young adults",
        "Has worked in South Africa since 1996",
      ],
      tags: ["Gillings faculty", "Global health"],
      touches: [
        {
          at: 150,
          type: "event",
          notes:
            "Seminar on HIV prevention research with adolescent girls and young women in southern Africa. David Osei recommended it.",
        },
      ],
      standing: "Public figure. Heard her global health seminar.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Professor and Associate Chair, Department of Epidemiology",
          2020,
          null,
        ],
      ],
      education: [
        ["University of Virginia", "Biomedical Ethics (BA)", 1992, 1996],
        [
          "University of California, Berkeley",
          "Maternal and Child Health (MPH)",
          1998,
          2000,
        ],
        [
          "University of California, Berkeley",
          "Epidemiology (PhD)",
          2000,
          2004,
        ],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2015/08/pettifor_audrey_738x714-738x714.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/audrey-pettifor-phd/",
  },
  {
    person: {
      fullName: "Jill Stewart",
      firstName: "Jill",
      lastName: "Stewart",
      title:
        "Adjunct Professor, Department of Environmental Sciences and Engineering",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "Environmental health guest lecture",
      metDaysAgo: 330,
      keyFacts: [
        "Develops techniques to detect and track pathogens in water",
        "Specialties include water and shellfish quality",
      ],
      tags: ["Gillings faculty"],
      touches: [
        {
          at: 330,
          type: "event",
          notes:
            "Guest lecture on water quality and environmental health in NC communities.",
        },
      ],
      standing: "Public figure. Heard her guest lecture.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Adjunct Professor, Department of Environmental Sciences and Engineering",
          2020,
          null,
        ],
      ],
      education: [
        ["University of Virginia", "Environmental Sciences (BA)", 1992, 1996],
        [
          "UNC Chapel Hill",
          "Environmental Sciences and Engineering (MS)",
          1996,
          1998,
        ],
        [
          "UNC Chapel Hill",
          "Environmental Sciences and Engineering (PhD)",
          1998,
          2003,
        ],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2019/06/Stewart-headshot-738x714h.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/jill-stewart-phd/",
  },
  {
    person: {
      fullName: "Penny Gordon-Larsen",
      firstName: "Penny",
      lastName: "Gordon-Larsen",
      title:
        "W. R. Kenan, Jr. Distinguished Professor of Nutrition; Vice Chancellor for Research, UNC Chapel Hill",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "UNC undergraduate research week",
      metDaysAgo: 180,
      keyFacts: [
        "Researches links between biology, behavior and environment in obesity and cardiometabolic disease",
        "Carolina faculty member since 2002",
      ],
      tags: ["Gillings faculty"],
      touches: [
        {
          at: 180,
          type: "event",
          notes:
            "Opening talk at undergraduate research week about getting involved in research early — part of why I applied to the Sheps RA job.",
        },
      ],
      standing:
        "Public figure. Her research week talk nudged you toward the Sheps RA job.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "W. R. Kenan, Jr. Distinguished Professor of Nutrition; Vice Chancellor for Research, UNC Chapel Hill",
          2020,
          null,
        ],
      ],
      education: [
        ["Tulane University", "Anthropology & Psychology (BA)", 1985, 1989],
        [
          "University of Pennsylvania",
          "Human Biology / Physical Anthropology (PhD)",
          1992,
          1997,
        ],
        ["UNC Chapel Hill", "Nutritional Epidemiology (Postdoc)", 1998, 2000],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2023/10/07032023_penny_gordon_larsen_horiz-738x714.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/penny-gordon-larsen-phd/",
  },
  {
    person: {
      fullName: "Mark Holmes",
      firstName: "Mark",
      lastName: "Holmes",
      title:
        "Director, Cecil G. Sheps Center for Health Services Research; Lambeth Distinguished Chair in Public Policy",
      company: "Cecil G. Sheps Center for Health Services Research",
      industry: "Research",
      location: "Chapel Hill, NC",
      closeness: 2,
      howMet: "Sheps Center all-hands",
      metDaysAgo: 210,
      keyFacts: [
        "Nationally recognized for research on rural hospital closures and Medicaid policy",
        "Also Senior Associate Dean for Faculty and Staff Affairs at Gillings",
      ],
      tags: ["Research", "Sheps Center"],
      touches: [
        {
          at: 210,
          type: "event",
          notes:
            "Sheps Center all-hands. He introduced the rural health research program and welcomed new RAs.",
        },
        {
          at: 25,
          type: "event",
          notes:
            "Sheps seminar on rural hospital closures. Dr. Elena Ruiz presented our early OB unit findings.",
        },
      ],
      standing: "Center director. Saw our early findings at the Sheps seminar.",
      history: [
        [
          "Cecil G. Sheps Center for Health Services Research",
          "Director, Cecil G. Sheps Center for Health Services Research; Lambeth Distinguished Chair in Public Policy",
          2020,
          null,
        ],
      ],
      education: [],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2015/09/holmes_mark_738x714-738x714.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/mark-holmes-phd/",
  },
  {
    person: {
      fullName: "Lee H. Roberts",
      firstName: "Lee",
      lastName: "Roberts",
      title: "Chancellor",
      company: "UNC Chapel Hill",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "University Day address",
      metDaysAgo: 375,
      keyFacts: [
        "Named 13th chancellor of UNC-Chapel Hill on Aug 9, 2024, after serving as interim chancellor",
        "Former North Carolina state budget director",
      ],
      tags: ["UNC"],
      touches: [
        {
          at: 375,
          type: "event",
          notes: "University Day address on the university's public mission, the fall I arrived.",
        },
      ],
      standing: "Public figure. Heard his University Day address.",
      history: [["UNC Chapel Hill", "Chancellor", 2020, null]],
      education: [
        ["Duke University", "BA", 1990, 1994],
        ["Yale Law School", "Law (JD)", 1990, 1994],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Lee_H._Roberts_UNCCH.jpg/500px-Lee_H._Roberts_UNCCH.jpg",
    sourceUrl: "https://www.unc.edu/about/leadership/chancellor/",
  },
  {
    person: {
      fullName: "Myron S. Cohen",
      firstName: "Myron",
      lastName: "Cohen",
      title:
        "Director, UNC Institute for Global Health and Infectious Diseases; Yeargan-Bate Eminent Distinguished Professor",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "Global health lecture series",
      metDaysAgo: 160,
      keyFacts: [
        "Led HPTN 052, which showed antiretroviral therapy prevents sexual HIV transmission",
        "Associate Vice Chancellor for Global Health at UNC-Chapel Hill",
      ],
      tags: ["Global health"],
      touches: [
        {
          at: 160,
          type: "event",
          notes:
            "Lecture on HIV treatment as prevention. Hannah Kim mentioned his work at FHI 360 too.",
        },
      ],
      standing: "Public figure. Heard his global health lecture.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Director, UNC Institute for Global Health and Infectious Diseases; Yeargan-Bate Eminent Distinguished Professor",
          2020,
          null,
        ],
      ],
      education: [
        ["University of Illinois", "Psychology (BS)", 1967, 1971],
        ["Rush Medical College", "Medicine (MD)", 1971, 1974],
        ["Yale University", "Infectious Disease (Fellowship)", 1977, 1980],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2021/06/cohen_myron_738x714.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/myron-cohen-md/",
  },
  {
    person: {
      fullName: "Jane Monaco",
      firstName: "Jane",
      lastName: "Monaco",
      title:
        "Assistant Dean of Undergraduate Degree Programs; Professor of Biostatistics",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 2,
      howMet: "BSPH orientation",
      metDaysAgo: 400,
      keyFacts: [
        "Oversees Gillings undergraduate (BSPH) degree programs",
        "Winner of the McGavran Excellence in Teaching Award (2013)",
      ],
      tags: ["Gillings faculty", "BSPH"],
      touches: [
        {
          at: 400,
          type: "event",
          notes:
            "BSPH orientation. She walked through the field experience requirement.",
        },
        {
          at: 30,
          type: "in_person",
          notes:
            "Undergraduate programs drop-in hours. Confirmed a health department practicum can count toward my field experience.",
        },
      ],
      standing:
        "Confirmed your practicum can count toward the BSPH field experience.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Assistant Dean of Undergraduate Degree Programs; Professor of Biostatistics",
          2020,
          null,
        ],
      ],
      education: [],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2025/10/jane-monaco-738x491-2025-.png",
    sourceUrl: "https://sph.unc.edu/adv_profile/jane-monaco-drph/",
  },
  {
    person: {
      fullName: "Patsy Polston",
      firstName: "Patsy",
      lastName: "Polston",
      title:
        "Associate Professor, Department of Health Behavior; Director, BSPH in Community and Global Public Health",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "BSPH program info session",
      metDaysAgo: 420,
      keyFacts: [
        "Named founding director of the BSPH program in Community and Global Public Health (2024)",
        "Gillings Teaching Innovation Award recipient",
      ],
      tags: ["Gillings faculty", "BSPH"],
      touches: [
        {
          at: 420,
          type: "event",
          notes:
            "BSPH info session. Talked about community-engaged public health work.",
        },
      ],
      standing: "Public figure. Met at the BSPH info session.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Associate Professor, Department of Health Behavior; Director, BSPH in Community and Global Public Health",
          2020,
          null,
        ],
      ],
      education: [
        [
          "UNC Chapel Hill",
          "Environmental Sciences and Engineering (PhD)",
          2010,
          2015,
        ],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2026/02/PatsyPolston_2026-scaled-e1771956741589-738x714.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/patsy-polston-phd/",
  },
  {
    person: {
      fullName: "Sean Sylvia",
      firstName: "Sean",
      lastName: "Sylvia",
      title: "Associate Professor, Department of Health Policy and Management",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "HPM research seminar",
      metDaysAgo: 55,
      keyFacts: [
        "Health and development economist using experimental methods to improve health service delivery",
        "Work published in BMJ, PLOS Medicine and Health Services Research",
      ],
      tags: ["Gillings faculty", "HPM"],
      touches: [
        {
          at: 55,
          type: "event",
          notes: "Seminar on behavioral economics in health systems in China.",
        },
      ],
      standing: "Heard his HPM seminar.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Associate Professor, Department of Health Policy and Management",
          2020,
          null,
        ],
      ],
      education: [
        [
          "University of Alabama",
          "Economics and International Studies (BA)",
          2002,
          2006,
        ],
        [
          "University of Maryland",
          "Agricultural and Resource Economics (MS)",
          2010,
          2012,
        ],
        [
          "University of Maryland",
          "Agricultural and Resource Economics (PhD)",
          2010,
          2014,
        ],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2021/04/Sylvia_Sean_hpmprofile_738x715-e1617899865898.jpg",
    sourceUrl: "https://sph.unc.edu/adv_profile/sean-sylvia-phd/",
  },
  {
    person: {
      fullName: "Justin Trogdon",
      firstName: "Justin",
      lastName: "Trogdon",
      title: "Professor, Department of Health Policy and Management",
      company: "UNC Gillings School of Global Public Health",
      industry: "Academia",
      location: "Chapel Hill, NC",
      closeness: 2,
      howMet: "HPM health economics course",
      metDaysAgo: 110,
      keyFacts: [
        "Health economist studying the economic burden of cancer",
        "Evaluates cost-effectiveness of public health interventions",
      ],
      tags: ["Gillings faculty", "HPM"],
      touches: [
        {
          at: 110,
          type: "event",
          notes:
            "First week of his health economics course. Cost-effectiveness basics — Daniel Okafor said these matter at RTI.",
        },
        {
          at: 14,
          type: "in_person",
          notes:
            "Office hours on cost-effectiveness analysis for the RTI conversation.",
        },
      ],
      standing: "Your health economics professor; went to office hours.",
      history: [
        [
          "UNC Gillings School of Global Public Health",
          "Professor, Department of Health Policy and Management",
          2020,
          null,
        ],
      ],
      education: [
        ["Baylor University", "Economics (BA)", 1995, 1999],
        ["Duke University", "Economics (MA)", 1999, 2001],
        ["Duke University", "Economics (PhD)", 1999, 2004],
      ],
    },
    photoUrl:
      "https://sph.unc.edu/wp-content/uploads/sites/112/2023/12/Justin-Trogson-2023-738x714.png",
    sourceUrl: "https://sph.unc.edu/adv_profile/justin-trogdon-phd/",
  },
  {
    person: {
      fullName: "Devdutta Sangvai",
      firstName: "Devdutta",
      lastName: "Sangvai",
      title: "Secretary",
      company: "NC Department of Health and Human Services",
      industry: "Government Health",
      location: "Raleigh, NC",
      closeness: 1,
      howMet: "NCPHA conference keynote",
      metDaysAgo: 26,
      keyFacts: [
        "19th NCDHHS Secretary, appointed by Gov. Josh Stein; leading the department since January 2025",
        "Family physician; co-convenes NC's Health Care Affordability Commission (2026)",
      ],
      tags: ["Policy"],
      touches: [
        {
          at: 26,
          type: "event",
          notes:
            "NCPHA keynote on Medicaid expansion and the state's public health priorities.",
        },
      ],
      standing: "Public figure. Heard his NCPHA keynote.",
      history: [
        ["NC Department of Health and Human Services", "Secretary", 2020, null],
      ],
      education: [],
    },
    photoUrl:
      "https://files.nc.gov/dhhs/styles/article_card/public/images/2025-02/Secretary%20Sangvai%20Headshot.jpg?VersionId=lwysV3WhoBOQ_9L2EJ5HV1JYXlTLizzq&itok=gCXHSf-A",
    sourceUrl: "https://www.ncdhhs.gov/about/leadership",
  },
  {
    person: {
      fullName: "Lawrence Greenblatt",
      firstName: "Lawrence",
      lastName: "Greenblatt",
      title: "State Health Director and Chief Medical Officer",
      company: "NC Department of Health and Human Services",
      industry: "Government Health",
      location: "Raleigh, NC",
      closeness: 1,
      howMet: "NCPHA conference plenary",
      metDaysAgo: 26,
      keyFacts: [
        "Became NC State Health Director in June 2025",
        "Three decades as a general internist and Medicaid policy leader at Duke University Health System",
      ],
      tags: ["Policy"],
      touches: [
        {
          at: 26,
          type: "event",
          notes: "NCPHA plenary on the state's public health workforce.",
        },
      ],
      standing: "Public figure. Heard his NCPHA plenary.",
      history: [
        [
          "NC Department of Health and Human Services",
          "State Health Director and Chief Medical Officer",
          2020,
          null,
        ],
      ],
      education: [],
    },
    photoUrl:
      "https://files.nc.gov/dhhs/styles/inline_medium/public/images/2025-05/greenblatt_headshot%20%281%29.jpeg",
    sourceUrl:
      "https://www.ncdhhs.gov/news/press-releases/2025/05/28/ncdhhs-names-new-state-health-director",
  },
  {
    person: {
      fullName: "Tim J. Gabel",
      firstName: "Tim",
      lastName: "Gabel",
      title: "President and CEO",
      company: "RTI International",
      industry: "Research",
      location: "Research Triangle Park, NC",
      closeness: 1,
      howMet: "RTI talk at the Gillings alumni panel week",
      metDaysAgo: 62,
      keyFacts: [
        "Fifth president and CEO of RTI International (since 2022)",
        "Previously led RTI's largest business unit as executive vice president",
      ],
      tags: ["RTI"],
      touches: [
        {
          at: 62,
          type: "event",
          notes:
            "Gave the welcome at an RTI open house for students. Priya Raman's team presented.",
        },
      ],
      standing: "Public figure. Heard him at RTI's student open house.",
      history: [["RTI International", "President and CEO", 2020, null]],
      education: [],
    },
    photoUrl:
      "https://www.rtp.org/wp-content/uploads/2023/02/TimGabel-scaled.jpg",
    sourceUrl:
      "https://www.rti.org/news/tim-j-gabel-named-president-and-chief-executive-officer-rti-international",
  },
  {
    person: {
      fullName: "Mark McClellan",
      firstName: "Mark",
      lastName: "McClellan",
      title: "Director, Duke-Margolis Institute for Health Policy",
      company: "Duke University",
      industry: "Health Policy",
      location: "Durham, NC",
      closeness: 1,
      howMet: "Duke-Margolis public webinar",
      metDaysAgo: 33,
      keyFacts: [
        "Former FDA Commissioner and CMS Administrator",
        "Robert J. Margolis, M.D., Professor of Business, Medicine and Policy",
      ],
      tags: ["Policy"],
      touches: [
        {
          at: 33,
          type: "event",
          notes:
            "Duke-Margolis webinar on Medicaid and value-based care. Samuel Grant sent the link.",
        },
      ],
      standing: "Public figure. Watched his Duke-Margolis webinar.",
      history: [
        [
          "Duke University",
          "Director, Duke-Margolis Institute for Health Policy",
          2020,
          null,
        ],
      ],
      education: [
        ["University of Texas at Austin", "BA", 1981, 1984],
        ["Harvard Kennedy School", "Public Administration (MPA)", 1987, 1991],
        ["Harvard Medical School / MIT HST", "Medicine (MD)", 1988, 1992],
        ["MIT", "Economics (PhD)", 1989, 1993],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/MarkMcClellan.jpg/500px-MarkMcClellan.jpg",
    sourceUrl: "https://scholars.duke.edu/person/mark.mcclellan",
  },
  {
    person: {
      fullName: "Chris Beyrer",
      firstName: "Chris",
      lastName: "Beyrer",
      title: "Director, Duke Global Health Institute",
      company: "Duke University",
      industry: "Global Health",
      location: "Durham, NC",
      closeness: 1,
      howMet: "Triangle Global Health Consortium panel",
      metDaysAgo: 165,
      keyFacts: [
        "HIV epidemiologist; former president of the International AIDS Society",
        "Leads DGHI through its 20th anniversary (2026)",
      ],
      tags: ["Global health"],
      touches: [
        {
          at: 165,
          type: "event",
          notes:
            "Panel on global HIV policy at a Triangle Global Health Consortium mixer.",
        },
      ],
      standing: "Public figure. Heard him on a consortium panel.",
      history: [
        [
          "Duke University",
          "Director, Duke Global Health Institute",
          2020,
          null,
        ],
      ],
      education: [],
    },
    photoUrl:
      "https://globalhealth.duke.edu/sites/default/files/styles/person_headshot_default/public/people/1a4a8273.jpg?itok=4gZ4WyrR",
    sourceUrl: "https://globalhealth.duke.edu/people/beyrer-chris",
  },
  {
    person: {
      fullName: "Adam Schechter",
      firstName: "Adam",
      lastName: "Schechter",
      title: "Chairman, President and CEO",
      company: "Labcorp",
      industry: "Pharma & Biotech",
      location: "Burlington, NC",
      closeness: 1,
      howMet: "RTP life sciences forum",
      metDaysAgo: 85,
      keyFacts: [
        "CEO of Labcorp since 2019 and board chair since 2020",
        "Previously president of Merck's Global Human Health division",
      ],
      tags: ["Pharma"],
      touches: [
        {
          at: 85,
          type: "event",
          notes:
            "Fireside chat at an RTP life sciences careers forum about diagnostics and public health testing.",
        },
      ],
      standing: "Public figure. Heard his fireside chat.",
      history: [["Labcorp", "Chairman, President and CEO", 2020, null]],
      education: [],
    },
    photoUrl:
      "https://content.labcorp.com/sites/default/files/2024-11/adam_schechter_0.png",
    sourceUrl: "https://www.labcorp.com/adam-schechter",
  },
  {
    person: {
      fullName: "Ari Bousbib",
      firstName: "Ari",
      lastName: "Bousbib",
      title: "Chairman and CEO",
      company: "IQVIA",
      industry: "Health Data & Analytics",
      location: "Durham, NC",
      closeness: 1,
      howMet: "IQVIA keynote livestream",
      metDaysAgo: 120,
      keyFacts: [
        "Has led IQVIA (formerly IMS Health) as chairman and CEO since 2010",
        "Former president of United Technologies' commercial companies",
      ],
      tags: ["Pharma"],
      touches: [
        {
          at: 120,
          type: "note",
          notes:
            "Watched his keynote on health data and real-world evidence before the career fair.",
        },
      ],
      standing: "Public figure. Watched his keynote.",
      history: [["IQVIA", "Chairman and CEO", 2020, null]],
      education: [],
    },
    photoUrl:
      "https://www.iqvia.com/-/media/iqvia/images/headshots/ari-bousbib.jpg",
    sourceUrl: "https://www.iqvia.com/about-us/leadership",
  },
  {
    person: {
      fullName: "Tessie San Martin",
      firstName: "Tessie",
      lastName: "San Martin",
      title: "Chief Executive Officer",
      company: "FHI 360",
      industry: "Global Health",
      location: "Durham, NC",
      closeness: 1,
      howMet: "FHI 360 public forum",
      metDaysAgo: 140,
      keyFacts: [
        "CEO of FHI 360 since September 2021",
        "Previously president and CEO of Plan International USA",
      ],
      tags: ["Global health"],
      touches: [
        {
          at: 140,
          type: "event",
          notes:
            "FHI 360 public forum on global health and development partnerships.",
        },
      ],
      standing: "Public figure. Heard her at an FHI 360 forum.",
      history: [["FHI 360", "Chief Executive Officer", 2020, null]],
      education: [],
    },
    photoUrl:
      "https://www.fhi360.org/wp-content/uploads/2025/09/tessie-san-martin.jpg",
    sourceUrl: "https://www.fhi360.org/leadership/",
  },
  {
    person: {
      fullName: "Louis J. Muglia",
      firstName: "Louis",
      lastName: "Muglia",
      title: "President and CEO",
      company: "Burroughs Wellcome Fund",
      industry: "Philanthropy",
      location: "Research Triangle Park, NC",
      closeness: 1,
      howMet: "NC science funding forum",
      metDaysAgo: 200,
      keyFacts: [
        "President and CEO of the Burroughs Wellcome Fund since January 2020",
        "Physician-scientist known for research on preterm birth genetics",
      ],
      tags: ["Philanthropy"],
      touches: [
        {
          at: 200,
          type: "event",
          notes:
            "Talk on the Burroughs Wellcome Fund's support for NC science education.",
        },
      ],
      standing: "Public figure. Heard his talk on science funding.",
      history: [["Burroughs Wellcome Fund", "President and CEO", 2020, null]],
      education: [],
    },
    photoUrl:
      "https://www.bwfund.org/wp-content/uploads/2024/04/Muglia2020-300x300.jpg",
    sourceUrl: "https://www.bwfund.org/about/staff/",
  },
  {
    person: {
      fullName: "Cristy Page",
      firstName: "Cristy",
      lastName: "Page",
      title: "CEO, UNC Health; Dean, UNC School of Medicine",
      company: "UNC Health",
      industry: "Health Systems",
      location: "Chapel Hill, NC",
      closeness: 1,
      howMet: "UNC Health leadership town hall",
      metDaysAgo: 48,
      keyFacts: [
        "Named UNC Health CEO in November 2025; first woman to lead the system",
        "Family physician with expertise in primary and rural health; former head of UNC Health Enterprises",
      ],
      tags: ["Health systems"],
      touches: [
        {
          at: 48,
          type: "event",
          notes:
            "Public town hall on UNC Health's rural care strategy. Sofia Alvarez flagged it.",
        },
      ],
      standing: "Public figure. Heard her rural care town hall.",
      history: [
        [
          "UNC Health",
          "CEO, UNC Health; Dean, UNC School of Medicine",
          2020,
          null,
        ],
      ],
      education: [],
    },
    photoUrl:
      "https://news.unchealthcare.org/wp-content/uploads/sites/1159/2025/11/PAGE_HEADSHOT-scaled.jpg",
    sourceUrl:
      "https://news.unchealthcare.org/2025/11/dr-cristy-page-named-ceo-of-unc-health-dean-of-unc-school-of-medicine/",
  },
  {
    person: {
      fullName: "Kyle Walsh",
      firstName: "Kyle",
      lastName: "Walsh",
      title:
        "Director, National Institute of Environmental Health Sciences and National Toxicology Program",
      company: "National Institute of Environmental Health Sciences",
      industry: "Government Health",
      location: "Research Triangle Park, NC",
      closeness: 1,
      howMet: "NIEHS public lecture",
      metDaysAgo: 100,
      keyFacts: [
        "Appointed NIEHS director in October 2025",
        "Brain tumor epidemiologist, formerly at Duke University",
      ],
      tags: ["Environmental health"],
      touches: [
        {
          at: 100,
          type: "event",
          notes:
            "NIEHS public lecture on environmental health research in the Triangle.",
        },
      ],
      standing: "Public figure. Heard his NIEHS lecture.",
      history: [
        [
          "National Institute of Environmental Health Sciences",
          "Director, National Institute of Environmental Health Sciences and National Toxicology Program",
          2020,
          null,
        ],
      ],
      education: [],
    },
    photoUrl:
      "https://www.niehs.nih.gov/sites/api-niehs/files/image/kyle-walsh-2025.jpg",
    sourceUrl: "https://www.niehs.nih.gov/about/od/director",
  },
  {
    person: {
      fullName: "Mandy Cohen",
      firstName: "Mandy",
      lastName: "Cohen",
      title: "National Advisor, Manatt Health",
      company: "Manatt Health",
      industry: "Health Policy",
      location: "Washington, DC",
      closeness: 2,
      howMet: "Gillings public health leadership lecture",
      metDaysAgo: 130,
      keyFacts: [
        "20th Director of the CDC (2023-2025)",
        "NC DHHS Secretary 2017-2021; led North Carolina's COVID-19 response",
      ],
      tags: ["Policy", "Inspiration"],
      touches: [
        {
          at: 130,
          type: "event",
          notes:
            "Leadership lecture on running NC DHHS through the pandemic and Medicaid transformation. Asked a question about getting into state government and she said: say yes to the practicum.",
        },
      ],
      standing: "Public figure. Her advice: say yes to the practicum.",
      history: [
        ["Manatt Health", "National Advisor, Manatt Health", 2020, null],
      ],
      education: [
        ["Cornell University", "BS", 1996, 2000],
        ["Yale School of Medicine", "Medicine (MD)", 2000, 2004],
        [
          "Harvard T.H. Chan School of Public Health",
          "Public Health (MPH)",
          2000,
          2004,
        ],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/Mandy_K._Cohen%2C_CDC_Director.jpg/500px-Mandy_K._Cohen%2C_CDC_Director.jpg",
    sourceUrl:
      "https://smhs.gwu.edu/news/mandy-k-cohen-md-mph-former-director-centers-disease-control-and-prevention-serve-keynote",
  },
  {
    person: {
      fullName: "Tedros Adhanom Ghebreyesus",
      firstName: "Tedros",
      lastName: "Adhanom Ghebreyesus",
      title: "Director-General",
      company: "World Health Organization",
      industry: "Global Health",
      location: "Geneva, Switzerland",
      closeness: 1,
      howMet: "World Health Assembly livestream",
      metDaysAgo: 140,
      keyFacts: [
        "WHO Director-General since 2017; second term runs to 2027",
        "Former Minister of Health and Minister of Foreign Affairs of Ethiopia",
      ],
      tags: ["Global health", "Inspiration"],
      touches: [
        {
          at: 140,
          type: "note",
          notes:
            "Watched his World Health Assembly opening address on primary health care for a global health class.",
        },
      ],
      standing: "Public figure. Watched his WHA address for class.",
      history: [["World Health Organization", "Director-General", 2020, null]],
      education: [
        ["University of Asmara", "Biology (BSc)", 1982, 1986],
        [
          "London School of Hygiene & Tropical Medicine",
          "Immunology of Infectious Diseases (MSc)",
          1988,
          1992,
        ],
        ["University of Nottingham", "Community Health (PhD)", 1996, 2000],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Tedros_Adhanom_Ghebreyesus_2024.jpg/500px-Tedros_Adhanom_Ghebreyesus_2024.jpg",
    sourceUrl: "https://www.who.int/director-general",
  },
  {
    person: {
      fullName: "Jeremy Farrar",
      firstName: "Jeremy",
      lastName: "Farrar",
      title: "Chief, Asia, Middle East and Europe Region",
      company: "PATH",
      industry: "Global Health",
      location: "Geneva, Switzerland",
      closeness: 1,
      howMet: "Global health security webinar",
      metDaysAgo: 90,
      keyFacts: [
        "Joined PATH's executive leadership team Oct 1, 2026, after serving as WHO Chief Scientist and Assistant Director-General",
        "Former director of the Wellcome Trust (2013-2023)",
      ],
      tags: ["Global health"],
      touches: [
        {
          at: 90,
          type: "note",
          notes:
            "Watched his webinar on global health security and research partnerships.",
        },
      ],
      standing: "Public figure. Watched his webinar.",
      history: [
        ["PATH", "Chief, Asia, Middle East and Europe Region", 2020, null],
      ],
      education: [
        ["University College London", "Medicine (MBBS)", 1982, 1986],
        ["University of Oxford", "DPhil", 1994, 1998],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Jeremy_Farrar%2C_Chief_Scientist%2C_World_Health_Organization_7_%28cropped%29.jpg/500px-Jeremy_Farrar%2C_Chief_Scientist%2C_World_Health_Organization_7_%28cropped%29.jpg",
    sourceUrl:
      "https://www.path.org/our-impact/media-center/path-appoints-dr-jeremy-farrar/",
  },
  {
    person: {
      fullName: "Mark Suzman",
      firstName: "Mark",
      lastName: "Suzman",
      title: "Chief Executive Officer",
      company: "Gates Foundation",
      industry: "Philanthropy",
      location: "Seattle, WA",
      closeness: 1,
      howMet: "Gates Foundation Goalkeepers livestream",
      metDaysAgo: 25,
      keyFacts: [
        "CEO of the Gates Foundation since 2020; joined the foundation in 2007",
        "Leading the foundation's 20-year spend-down plan to 2045",
      ],
      tags: ["Global health", "Philanthropy"],
      touches: [
        {
          at: 25,
          type: "note",
          notes:
            "Watched the Goalkeepers report livestream on child mortality trends.",
        },
      ],
      standing: "Public figure. Watched the Goalkeepers livestream.",
      history: [["Gates Foundation", "Chief Executive Officer", 2020, null]],
      education: [
        ["Harvard University", "BA", 1990, 1994],
        [
          "University of Oxford",
          "DPhil, International Relations (Rhodes Scholar)",
          1990,
          1994,
        ],
      ],
    },
    photoUrl:
      "https://www.gatesfoundation.org/-/media/gfo/3about/3people/mark_suzman_20250212_0001.jpg?rev=29ad752a62904adabae2c382a706b80a",
    sourceUrl: "https://www.gatesfoundation.org/about/leadership/mark-suzman",
  },
  {
    person: {
      fullName: "Sania Nishtar",
      firstName: "Sania",
      lastName: "Nishtar",
      title: "Chief Executive Officer",
      company: "Gavi, the Vaccine Alliance",
      industry: "Global Health",
      location: "Geneva, Switzerland",
      closeness: 1,
      howMet: "Vaccine equity panel livestream",
      metDaysAgo: 115,
      keyFacts: [
        "Gavi CEO since March 2024, leading the 2026-2030 strategy",
        "Cardiologist and former Pakistani senator; founded the think tank Heartfile",
      ],
      tags: ["Global health"],
      touches: [
        {
          at: 115,
          type: "note",
          notes: "Watched her panel on vaccine financing and equity.",
        },
      ],
      standing: "Public figure. Watched her vaccine equity panel.",
      history: [
        ["Gavi, the Vaccine Alliance", "Chief Executive Officer", 2020, null],
      ],
      education: [
        ["Khyber Medical College", "Medicine (MBBS)", 1982, 1986],
        ["King's College London", "PhD", 1998, 2002],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Sania_Nishtar_at_the_World_Economic_Forum_on_India_2012.jpg/500px-Sania_Nishtar_at_the_World_Economic_Forum_on_India_2012.jpg",
    sourceUrl:
      "https://www.gavi.org/operating-model/gavi-secretariat/dr-sania-nishtar",
  },
  {
    person: {
      fullName: "Peter Sands",
      firstName: "Peter",
      lastName: "Sands",
      title: "Executive Director",
      company: "The Global Fund",
      industry: "Global Health",
      location: "Geneva, Switzerland",
      closeness: 1,
      howMet: "Global Fund replenishment briefing",
      metDaysAgo: 170,
      keyFacts: [
        "Executive Director of the Global Fund to Fight AIDS, Tuberculosis and Malaria since 2018; term extended to end of 2026",
        "Former Group CEO of Standard Chartered",
      ],
      tags: ["Global health"],
      touches: [
        {
          at: 170,
          type: "note",
          notes:
            "Read and annotated his replenishment briefing for a class discussion on HIV, TB and malaria financing.",
        },
      ],
      standing: "Public figure. Studied his briefing for class.",
      history: [["The Global Fund", "Executive Director", 2020, null]],
      education: [
        [
          "University of Oxford",
          "Philosophy, Politics and Economics (BA)",
          1990,
          1994,
        ],
        ["Harvard Kennedy School", "Public Administration (MPA)", 1990, 1994],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/2/24/UN_AI_for_Good_Summit_2025_-_Peter_Sands_05_%28cropped%29.jpg/500px-UN_AI_for_Good_Summit_2025_-_Peter_Sands_05_%28cropped%29.jpg",
    sourceUrl: "https://www.theglobalfund.org/en/staff/executive-director/",
  },
  {
    person: {
      fullName: "Peter Hotez",
      firstName: "Peter",
      lastName: "Hotez",
      title:
        "Dean, National School of Tropical Medicine; Co-Director, Texas Children's Center for Vaccine Development",
      company: "Baylor College of Medicine",
      industry: "Global Health",
      location: "Houston, TX",
      closeness: 1,
      howMet: "Neglected tropical diseases lecture",
      metDaysAgo: 260,
      keyFacts: [
        "Co-developed a low-cost, patent-free COVID-19 vaccine (Corbevax)",
        "Professor of Pediatrics and Molecular Virology & Microbiology",
      ],
      tags: ["Global health", "Inspiration"],
      touches: [
        {
          at: 260,
          type: "event",
          notes:
            "Virtual guest lecture on neglected tropical diseases and vaccine science communication.",
        },
      ],
      standing: "Public figure. Heard his virtual guest lecture.",
      history: [
        [
          "Baylor College of Medicine",
          "Dean, National School of Tropical Medicine; Co-Director, Texas Children's Center for Vaccine Development",
          2020,
          null,
        ],
      ],
      education: [
        [
          "Yale University",
          "Molecular Biophysics and Biochemistry (BA)",
          1976,
          1980,
        ],
        ["Rockefeller University", "PhD", 1982, 1986],
        ["Weill Cornell Medical College", "Medicine (MD)", 1983, 1987],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/Peter_Hotez_2019_Texas_Book_Festival.jpg/500px-Peter_Hotez_2019_Texas_Book_Festival.jpg",
    sourceUrl:
      "https://bcm.edu/people/view/peter-hotez-m-d-ph-d/b1846a47-ffed-11e2-be68-080027880ca6",
  },
  {
    person: {
      fullName: "Anthony Fauci",
      firstName: "Anthony",
      lastName: "Fauci",
      title: "Distinguished University Professor",
      company: "Georgetown University",
      industry: "Academia",
      location: "Washington, DC",
      closeness: 1,
      howMet: "Georgetown public lecture livestream",
      metDaysAgo: 230,
      keyFacts: [
        "Director of NIAID from 1984 to 2022",
        "Appointed in Georgetown's Division of Infectious Diseases and McCourt School of Public Policy",
      ],
      tags: ["Inspiration"],
      touches: [
        {
          at: 230,
          type: "note",
          notes:
            "Watched his public lecture on lessons from five decades of infectious disease work.",
        },
      ],
      standing: "Public figure. Watched his public lecture.",
      history: [
        [
          "Georgetown University",
          "Distinguished University Professor",
          2020,
          null,
        ],
      ],
      education: [
        ["College of the Holy Cross", "Classics (BA)", 1958, 1962],
        ["Cornell University Medical College", "Medicine (MD)", 1962, 1966],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/af/Anthony_Fauci_in_2023_%283x4_cropped%29.jpg/500px-Anthony_Fauci_in_2023_%283x4_cropped%29.jpg",
    sourceUrl:
      "https://biomedicalprograms.georgetown.edu/news/anthony-fauci-shares-disease-fighting-expertise-with-georgetown-students/",
  },
  {
    person: {
      fullName: "Agnes Binagwaho",
      firstName: "Agnes",
      lastName: "Binagwaho",
      title: "Co-Founder and Retired Vice Chancellor",
      company: "University of Global Health Equity",
      industry: "Global Health",
      location: "Kigali, Rwanda",
      closeness: 1,
      howMet: "Global health equity webinar",
      metDaysAgo: 190,
      keyFacts: [
        "Minister of Health of Rwanda, 2011-2016",
        "Elected International Honorary Member of the American Academy of Arts and Sciences (2026)",
      ],
      tags: ["Global health", "Inspiration"],
      touches: [
        {
          at: 190,
          type: "note",
          notes:
            "Webinar on rebuilding Rwanda's health system and training health workers. David Osei recommended it.",
        },
      ],
      standing: "Public figure. Watched her webinar.",
      history: [
        [
          "University of Global Health Equity",
          "Co-Founder and Retired Vice Chancellor",
          2020,
          null,
        ],
      ],
      education: [],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cf/Agnes_Binagwaho.jpg/500px-Agnes_Binagwaho.jpg",
    sourceUrl: "https://www.amacad.org/person/agnes-binagwaho",
  },
  {
    person: {
      fullName: "Atul Gawande",
      firstName: "Atul",
      lastName: "Gawande",
      title: "Samuel O. Thier Professor of the Practice of Surgery",
      company: "Harvard Medical School",
      industry: "Academia",
      location: "Boston, MA",
      closeness: 1,
      howMet: "Public lecture on health systems",
      metDaysAgo: 300,
      keyFacts: [
        "Former USAID Assistant Administrator for Global Health; founder of Ariadne Labs",
        "Surgeon at Brigham and Women's Hospital and New Yorker staff writer",
      ],
      tags: ["Inspiration"],
      touches: [
        {
          at: 300,
          type: "note",
          notes:
            "Read his writing on checklists and watched his lecture on health system performance for HPM.",
        },
      ],
      standing: "Public figure. His work came up in HPM.",
      history: [
        [
          "Harvard Medical School",
          "Samuel O. Thier Professor of the Practice of Surgery",
          2020,
          null,
        ],
      ],
      education: [
        [
          "Stanford University",
          "Biology and Political Science (BA/BS)",
          1983,
          1987,
        ],
        [
          "University of Oxford",
          "Philosophy, Politics and Economics (Rhodes Scholar)",
          1987,
          1989,
        ],
        ["Harvard Medical School", "Medicine (MD)", 1991, 1995],
        ["Harvard School of Public Health", "Public Health (MPH)", 1995, 1999],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/Atul_Gawande%2C_USAID_Assistant_Administrator.jpg/500px-Atul_Gawande%2C_USAID_Assistant_Administrator.jpg",
    sourceUrl:
      "https://www.brighamandwomens.org/surgery/find-a-doctor/profile/atul-gawande",
  },
  {
    person: {
      fullName: "Winnie Byanyima",
      firstName: "Winnie",
      lastName: "Byanyima",
      title:
        "Executive Director, UNAIDS; Under-Secretary-General of the United Nations",
      company: "UNAIDS",
      industry: "Global Health",
      location: "Geneva, Switzerland",
      closeness: 1,
      howMet: "World AIDS Day livestream",
      metDaysAgo: 315,
      keyFacts: [
        "Executive Director of UNAIDS since 2019",
        "Former executive director of Oxfam International; aeronautical engineer by training",
      ],
      tags: ["Global health"],
      touches: [
        {
          at: 315,
          type: "note",
          notes: "Watched her World AIDS Day address on inequality and HIV.",
        },
      ],
      standing: "Public figure. Watched her World AIDS Day address.",
      history: [
        [
          "UNAIDS",
          "Executive Director, UNAIDS; Under-Secretary-General of the United Nations",
          2020,
          null,
        ],
      ],
      education: [
        [
          "University of Manchester",
          "Aeronautical Engineering (BSc)",
          1990,
          1994,
        ],
        ["Cranfield University", "Mechanical Engineering (MSc)", 1990, 1994],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Winnie_Byanyima%2C_directrice_ex%C3%A9cutive_d%27Oxfam_international_%28cropped%29.jpg/500px-Winnie_Byanyima%2C_directrice_ex%C3%A9cutive_d%27Oxfam_international_%28cropped%29.jpg",
    sourceUrl:
      "https://www.unaids.org/en/aboutunaids/unaidsleadership/bios/winnie-byanyima",
  },
  {
    person: {
      fullName: "Jean Kaseya",
      firstName: "Jean",
      lastName: "Kaseya",
      title: "Director-General",
      company: "Africa CDC",
      industry: "Global Health",
      location: "Addis Ababa, Ethiopia",
      closeness: 1,
      howMet: "Africa health security webinar",
      metDaysAgo: 80,
      keyFacts: [
        "Appointed Africa CDC Director-General by the African Union Assembly in February 2023",
        "Co-chair of the G20 High-Level Independent Panel on financing pandemic preparedness",
      ],
      tags: ["Global health"],
      touches: [
        {
          at: 80,
          type: "note",
          notes:
            "Watched his webinar on African health sovereignty and outbreak response.",
        },
      ],
      standing: "Public figure. Watched his webinar.",
      history: [["Africa CDC", "Director-General", 2020, null]],
      education: [],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/4/40/EU2024BE_240320_European_Union_-_African_High_-_Level_evenement_on_Health_Egmont_Palace_-_49.jpg/500px-EU2024BE_240320_European_Union_-_African_High_-_Level_evenement_on_Health_Egmont_Palace_-_49.jpg",
    sourceUrl: "https://africacdc.org/",
  },
  {
    person: {
      fullName: "Tom Frieden",
      firstName: "Tom",
      lastName: "Frieden",
      title: "President and CEO",
      company: "Resolve to Save Lives",
      industry: "Global Health",
      location: "New York, NY",
      closeness: 1,
      howMet: "Resolve to Save Lives webinar",
      metDaysAgo: 105,
      keyFacts: [
        "Director of the CDC, 2009-2017; former New York City Health Commissioner",
        "Author of The Formula for Better Health (reviewed 2026)",
      ],
      tags: ["Global health"],
      touches: [
        {
          at: 105,
          type: "note",
          notes:
            "Webinar on hypertension control programs that save lives at scale.",
        },
      ],
      standing: "Public figure. Watched his webinar.",
      history: [["Resolve to Save Lives", "President and CEO", 2020, null]],
      education: [
        ["Oberlin College", "Philosophy (BA)", 1978, 1982],
        [
          "Columbia University",
          "Medicine (MD) and Public Health (MPH)",
          1982,
          1986,
        ],
      ],
    },
    photoUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7a/Thomas_Frieden_official_CDC_portrait.jpg/500px-Thomas_Frieden_official_CDC_portrait.jpg",
    sourceUrl: "https://resolvetosavelives.org/about/press",
  },
];
