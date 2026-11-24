export interface VietnamBankPreset {
  code: string
  bin: string
  shortName: string
  name: string
}

export const VIETNAM_BANKS: VietnamBankPreset[] = [
  { code: "VCB", bin: "970436", shortName: "Vietcombank", name: "Ngân hàng TMCP Ngoại thương Việt Nam" },
  { code: "TCB", bin: "970407", shortName: "Techcombank", name: "Ngân hàng TMCP Kỹ thương Việt Nam" },
  { code: "MB", bin: "970422", shortName: "MBBank", name: "Ngân hàng TMCP Quân đội" },
  { code: "BIDV", bin: "970418", shortName: "BIDV", name: "Ngân hàng TMCP Đầu tư và Phát triển VN" },
  { code: "ICB", bin: "970415", shortName: "VietinBank", name: "Ngân hàng TMCP Công thương Việt Nam" },
  { code: "ACB", bin: "970416", shortName: "ACB", name: "Ngân hàng TMCP Á Châu" },
  { code: "VPB", bin: "970432", shortName: "VPBank", name: "Ngân hàng TMCP Việt Nam Thịnh Vượng" },
  { code: "TPB", bin: "970423", shortName: "TPBank", name: "Ngân hàng TMCP Tiên Phong" },
  { code: "STB", bin: "970403", shortName: "Sacombank", name: "Ngân hàng TMCP Sài Gòn Thương Tín" },
  { code: "VIB", bin: "970441", shortName: "VIB", name: "Ngân hàng TMCP Quốc tế Việt Nam" },
  { code: "HDB", bin: "970437", shortName: "HDBank", name: "Ngân hàng TMCP Phát triển TP.HCM" },
  { code: "OCB", bin: "970448", shortName: "OCB", name: "Ngân hàng TMCP Phương Đông" },
  { code: "MSB", bin: "970426", shortName: "MSB", name: "Ngân hàng TMCP Hàng Hải" },
  { code: "VBA", bin: "970405", shortName: "Agribank", name: "Ngân hàng Nông nghiệp & PTNT VN" }
]
