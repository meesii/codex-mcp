import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Dialog as DialogPrimitive, Switch as SwitchPrimitive, Tabs as TabsPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "../utils.js";

const buttonVariants = cva(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] [&_svg]:size-4",
    {
        variants: {
            variant: {
                default: "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]",
                secondary: "border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-hover)]",
                ghost: "text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]",
                danger: "border border-[var(--danger-border)] bg-[var(--surface)] text-[var(--danger)] hover:bg-[var(--danger-soft)]",
            },
            size: {
                default: "h-10 px-4",
                sm: "h-8 rounded-lg px-3 text-xs",
                icon: "size-10 p-0",
            },
        },
        defaultVariants: { variant: "default", size: "default" },
    },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps): React.JSX.Element {
    return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Badge({ className, tone = "neutral", ...props }: React.HTMLAttributes<HTMLSpanElement> & {
    tone?: "neutral" | "success" | "warning" | "danger";
}): React.JSX.Element {
    const tones = {
        neutral: "bg-[var(--surface-muted)] text-[var(--muted-foreground)]",
        success: "bg-[var(--success-soft)] text-[var(--success)]",
        warning: "bg-[var(--warning-soft)] text-[var(--warning)]",
        danger: "bg-[var(--danger-soft)] text-[var(--danger)]",
    };
    return <span className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium", tones[tone], className)} {...props} />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
    return <div className={cn("rounded-2xl border border-[var(--border)] bg-[var(--surface)]", className)} {...props} />;
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
    return <input className={cn("h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--placeholder)] hover:border-[var(--border-strong)] focus:border-[var(--foreground)] focus:ring-2 focus:ring-[var(--focus-soft)]", className)} {...props} />;
}

export function NativeSelect({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
    return <select className={cn("h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 text-sm text-[var(--foreground)] outline-none hover:border-[var(--border-strong)] focus:border-[var(--foreground)] focus:ring-2 focus:ring-[var(--focus-soft)]", className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
    return <label className={cn("text-sm font-medium text-[var(--foreground)]", className)} {...props} />;
}

export function Switch({ checked, onCheckedChange, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
    return (
        <SwitchPrimitive.Root checked={checked} onCheckedChange={onCheckedChange} className="relative h-6 w-10 rounded-full bg-[var(--switch-off)] outline-none transition-colors data-[state=checked]:bg-[var(--primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]" {...props}>
            <SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
        </SwitchPrimitive.Root>
    );
}

export const Tabs = TabsPrimitive.Root;
export const TabsList = React.forwardRef<React.ElementRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
    ({ className, ...props }, ref) => <TabsPrimitive.List ref={ref} className={cn("inline-flex rounded-xl bg-[var(--surface-muted)] p-1", className)} {...props} />,
);
export const TabsTrigger = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
    ({ className, ...props }, ref) => <TabsPrimitive.Trigger ref={ref} className={cn("rounded-lg px-3 py-1.5 text-sm text-[var(--muted-foreground)] outline-none transition-colors data-[state=active]:bg-[var(--surface)] data-[state=active]:text-[var(--foreground)] data-[state=active]:shadow-sm focus-visible:ring-2 focus-visible:ring-[var(--focus)]", className)} {...props} />,
);
export const TabsContent = TabsPrimitive.Content;

export function Modal({ open, onOpenChange, title, description, children, footer }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    children?: React.ReactNode;
    footer?: React.ReactNode;
}): React.JSX.Element {
    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
                <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-[var(--foreground)] shadow-2xl outline-none data-[state=open]:animate-[dialog-in_180ms_ease-out]">
                    <DialogPrimitive.Title className="font-display text-lg font-semibold tracking-[-0.02em]">{title}</DialogPrimitive.Title>
                    {description && <DialogPrimitive.Description className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">{description}</DialogPrimitive.Description>}
                    {children && <div className="mt-5">{children}</div>}
                    {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
                    <DialogPrimitive.Close className="absolute right-4 top-4 rounded-lg p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" aria-label="关闭">
                        <X className="size-4" />
                    </DialogPrimitive.Close>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}

export function Sheet({ open, onOpenChange, title, description, children, side = "right" }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    children: React.ReactNode;
    side?: "left" | "right";
}): React.JSX.Element {
    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
                <DialogPrimitive.Content className={cn(
                    "fixed inset-y-0 z-50 w-[min(92vw,430px)] overflow-y-auto bg-[var(--surface)] p-6 text-[var(--foreground)] shadow-2xl outline-none",
                    side === "left"
                        ? "left-0 border-r border-[var(--border)] data-[state=open]:animate-[sheet-in-left_220ms_ease-out]"
                        : "right-0 border-l border-[var(--border)] data-[state=open]:animate-[sheet-in_220ms_ease-out]",
                )}>
                    <DialogPrimitive.Title className="font-display text-xl font-semibold tracking-[-0.025em]">{title}</DialogPrimitive.Title>
                    {description && <DialogPrimitive.Description className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">{description}</DialogPrimitive.Description>}
                    <div className="mt-7">{children}</div>
                    <DialogPrimitive.Close className="absolute right-4 top-4 rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" aria-label="关闭">
                        <X className="size-4" />
                    </DialogPrimitive.Close>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
