import { ActionMenu } from '../../../ui/action_menu';
import type { Option } from '../../../ui/option';
import { SOFT_PROOFS, type SoftProof } from './soft_proof';
import { SoftProofMenuStrings as strings } from './soft_proof_menu.strings';

const OPTIONS: Record<SoftProof, () => string> = {
  hdr: strings.hdrOption,
  srgb: strings.sdrOption,
  print: strings.print,
  print3d: strings.print3d,
};

const SHOWN: Record<SoftProof, () => string> = {
  hdr: strings.hdr,
  srgb: strings.sdr,
  print: strings.print,
  print3d: strings.print3d,
};

/**
 * Every proof, the one in force marked.
 *
 * `hdrOffered` is false where what is on screen has no HDR to proof against.
 */
export function softProofOptions(value: SoftProof, hdrOffered: boolean): Option<SoftProof>[] {
  return SOFT_PROOFS.map((proof) => ({
    value: proof,
    label: OPTIONS[proof](),
    active: proof === value,
    ...(proof === 'hdr' && !hdrOffered ? { disabled: true, tooltip: strings.hdrNeedsHdrRendition() } : {}),
  }));
}

/** The header's soft proof choice, named for the proof in force. */
export function SoftProofMenu({
  value,
  onChange,
  hdrOffered,
}: {
  value: SoftProof;
  onChange: (proof: SoftProof) => void;
  hdrOffered: boolean;
}): JSX.Element {
  const shown = SHOWN[value]();
  return (
    <ActionMenu
      trigger={shown}
      label={strings.softProofAs(shown)}
      options={softProofOptions(value, hdrOffered)}
      onSelect={onChange}
    />
  );
}
