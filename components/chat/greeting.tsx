"use client";

import { motion } from "framer-motion";
import { PRODUCT_NAME } from "@/lib/brand";
import { BrandMark } from "../effects/brand-mark";

export const Greeting = () => (
  <motion.div
    animate={{ opacity: 1, y: 0 }}
    className="flex flex-col items-center px-4 pb-40 text-center md:pb-48"
    initial={{ opacity: 0, y: 8 }}
    key="overview"
    transition={{ duration: 0.35, ease: "easeOut" }}
  >
    <BrandMark size={52} />
    <p className="mt-4 text-sm font-medium tracking-wide text-white/80">
      {PRODUCT_NAME}
    </p>
    <h1 className="mt-3 text-balance font-semibold text-[27px] tracking-tight text-white drop-shadow-[0_2px_14px_oklch(0_0_0/0.45)] md:text-[36px]">
      校园里的事，一起解决。
    </h1>
    <p className="mt-3 max-w-md text-[14px] leading-7 text-white/75 drop-shadow-[0_1px_8px_oklch(0_0_0/0.4)] md:text-[15px]">
      查找校园信息，发布互助消息，或说说你需要什么帮助。
    </p>
    <p className="mt-3 text-[12px] leading-5 text-white/60 drop-shadow-[0_1px_8px_oklch(0_0_0/0.4)]">
      部分信息为演示数据，重要事项请以学校通知为准。
    </p>
  </motion.div>
);
