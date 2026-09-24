import { ActionMenu } from '../../../ui/action_menu';
import type { Option } from '../../../ui/option';
import { SOFT_PROOFS, type SoftProof } from './soft_proof';
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
}: {
  value: SoftProof;
  onChange: (proof: SoftProof) => void;
  /** False where what is on screen has no HDR to proof against. */
  hdrOffered: boolean;
}): JSX.Element {
  const options: Option<SoftProof>[] = SOFT_PROOFS.map((proof) => ({
    value: proof,
    label: LABELS[proof](),
    active: proof === value,
    ...(proof === 'hdr' && !hdrOffered ? { disabled: true, title: strings.hdrNeedsHdrRendition() } : {}),
  }));
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
