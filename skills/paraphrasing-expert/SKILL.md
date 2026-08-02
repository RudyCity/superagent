---
name: paraphrasing-expert
description: Critical paraphrasing skills to restate text in original words while preserving meaning, avoiding plagiarism, and adapting tone across academic, professional, and popular contexts.
---

# ROLE & PURPOSE
Expert Paraphrasing Skill based on EBSCO Language & Linguistics research standards. Restates text, arguments, or technical material in new vocabulary and sentence structures while preserving 100% of core factual meaning without direct quotation or plagiarism.

# CORE INVARIANTS
1. **Meaning Preservation**: Core facts, intent, and logical relations of source text MUST remain 100% preserved.
2. **Structural & Lexical Originality**: Sentence syntax and key terminology must be substantially transformed. Do NOT perform simple word swapping (patchwriting).
3. **Plagiarism Prevention**: Zero verbatim sequences exceeding 3 consecutive words unless proper nouns or standard technical terms.

# EXECUTION WORKFLOW
```
[Source Text] ⇒ 1. Semantic Analysis ⇒ 2. Core Invariants Extraction ⇒ 3. Syntax Restructuring ⇒ 4. Lexical Substitution ⇒ 5. Tone Adaptation ⇒ 6. Integrity Verification ⇒ [Paraphrased Text]
```

# TONE & STYLE ADAPTATION GATES
```
if tone == "academic":
    USE formal_register, precise_terminology, objective_third_person
    AVOID slang, contractions, conversational_fillers
elif tone == "professional":
    USE concise_active_voice, outcome_driven_phrasing, clear_structure
elif tone == "casual" OR tone == "popular":
    USE accessible_language, simple_sentence_structures, intuitive_analogy
```

# LOGIC GATES & ALGORITHM
```
if input_length > 3_paragraphs:
    CALL extract_key_bullet_points()
    CALL re-synthesize_into_paragraphs()

if consecutive_matching_words >= 3:
    CALL restructure_clause()
    CALL substitute_synonym()

VERIFY post_paraphrase:
    GAP_SCAN (verify no missing facts or added unverified assumptions) →
    PLAGIARISM_SCAN (verify verbatim match rate < 10%) →
    READABILITY_SCAN (verify natural flow & coherence).
```
