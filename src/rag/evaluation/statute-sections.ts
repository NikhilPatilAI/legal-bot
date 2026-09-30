// Splits the extracted text of an Indian Act into its numbered sections, for
// building verifier benchmarks from laws the verifier was never tuned on.
//
// Two layouts are common in official PDFs:
//   with marginal headings:  "7. Designated partners.— (1) Every limited ..."
//   without headings:        "10. (1) A trade mark may be limited ..."
// Both are tried and the layout that yields more sections is used. Section
// numbers must increase through the Act, which rejects table-of-contents
// entries, footnotes ("1. Subs. by Act 31 of 2021 ...") and list items.

export interface StatuteSection {
  section: string;
  heading: string;
  text: string;
}

const WITH_HEADING =
  /^(\d{1,3})([A-Z]{0,2})\.\s+([A-Z][^\n]{2,140}?)\s*[.,]?\s*(?:[—–]|-{1,3})\s*/gmu;
const WITHOUT_HEADING =
  /^(\d{1,3})([A-Z]{0,2})\.\s+(?=\(1\)\s|(?:The|A|An|Every|No|Any|Where|If|Nothing|Save|Subject)\s)/gmu;
const FOOTNOTE =
  /^(?:Subs|Ins|Omitted|Added|Renumbered|The words|Vide|See|Rep|Cl\.|Clause|Sub-section)\b/u;
// Repealed runs (FEMA sections 20-26, for example) leave gaps.
const MAX_STEP = 10;

export function splitStatuteSections(pages: readonly string[]): StatuteSection[] {
  const text = pages
    .map((page) =>
      page
        .normalize('NFKC')
        .split('\n')
        // Page furniture: running headers, chapter titles and bare page numbers.
        .filter(
          (line) =>
            !/^\s*\d{1,4}\s*$/u.test(line) &&
            !/^THE GAZETTE OF INDIA/iu.test(line.trim()) &&
            !/^\s*CHAPTER\s+[IVXLC]+/u.test(line),
        )
        .join('\n'),
    )
    .join('\n');
  const withHeadings = split(text, WITH_HEADING, true);
  const withoutHeadings = split(text, WITHOUT_HEADING, false);
  return withHeadings.length >= withoutHeadings.length ? withHeadings : withoutHeadings;
}

function split(text: string, pattern: RegExp, hasHeading: boolean): StatuteSection[] {
  const starts: Array<{
    index: number;
    number: number;
    suffix: string;
    heading: string;
    bodyStart: number;
  }> = [];
  let last = 0;
  let lastSuffix = '';
  for (const match of text.matchAll(pattern)) {
    const number = Number(match[1]);
    const suffix = match[2] ?? '';
    const heading = hasHeading ? match[3]!.trim() : '';
    const bodyStart = match.index + match[0].length;
    if (FOOTNOTE.test(hasHeading ? heading : text.slice(bodyStart, bodyStart + 20))) continue;
    // Inserted sections ("10A") follow their base number.
    const advances =
      (number > last && number - last <= MAX_STEP) || (number === last && suffix > lastSuffix);
    if (!advances) continue;
    starts.push({ index: match.index, number, suffix, heading, bodyStart });
    last = number;
    lastSuffix = suffix;
  }
  return starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? text.length;
    const body = text
      .slice(start.bodyStart, end)
      // Footnote lines at page ends ("1. Subs. by Act ... w.e.f. ...").
      .replace(/^\s*\d{1,3}\.\s+(?:Subs|Ins|Omitted|Added|The words)\b[^\n]*$/gmu, '')
      .replace(/[ \t]+/gu, ' ')
      .trim();
    const id = `${start.number}${start.suffix}`;
    const heading = start.heading.replace(/[.,]$/u, '');
    return {
      section: id,
      heading,
      text: heading ? `${id}. ${heading}.— ${body}` : `${id}. ${body}`,
    };
  });
}
