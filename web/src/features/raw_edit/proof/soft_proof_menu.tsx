import { ActionMenu } from '../../../ui/action_menu';
import type { Option } from '../../../ui/option';
import { isPrintProof, SOFT_PROOFS, type SoftProof } from './soft_proof';
import { SoftProofMenuStrings as strings } from './soft_proof_menu.strings';

const LABELS: Record<SoftProof, () => string> = {
  hdr: strings.hdrDefault,
  srgb: strings.srgb,
  print: strings.print,
  print3d: strings.print3d,
};

/** The header's soft proof choice, named for the proof in force once one is. */
export function SoftProofMenu({
  value,
  onChange,
  hdrOffered,
  printOffered,
}: {
  value: SoftProof;
  onChange: (proof: SoftProof) => void;
  /** False where what is on screen has no HDR to proof against. */
  hdrOffered: boolean;
  /** False where there is no original to print from. */
  printOffered: boolean;
}): JSX.Element {
  const withheld = (proof: SoftProof): string | null =>
    proof === 'hdr' && !hdrOffered ? strings.hdrNeedsHdrRendition()
    : isPrintProof(proof) && !printOffered ? strings.printNeedsOriginal()
    : null;
  const options: Option<SoftProof>[] = SOFT_PROOFS.map((proof) => {
    const why = withheld(proof);
    return {
      value: proof,
      label: LABELS[proof](),
      active: proof === value,
      ...(why == null ? {} : { disabled: true, title: why }),
    };
  });
  const shown = value === 'hdr' ? null : LABELS[value]();
  return (
    <ActionMenu
      trigger={shown ?? strings.softProof()}
      label={shown == null ? strings.softProof() : strings.softProofAs(shown)}
      options={options}
      onSelect={onChange}
    />
  );
}
