import React from "react";
interface WizardDialogProps {
    title: string;
    description?: string;
    borderColor: "yellow" | "cyan" | "magenta" | "green" | "gray" | "white" | "red";
    options: string[];
    selectedIndex: number;
    maxVisible?: number;
    isMultiSelect?: boolean;
    selectedSet?: Set<number>;
    marginY?: number;
    marginTop?: number;
    marginBottom?: number;
    isLoading?: boolean;
    searchQuery?: string;
    searchPlaceholder?: string;
    terminalWidth?: number;
}
export declare function WizardDialog({ title, description, borderColor, options, selectedIndex, maxVisible, isMultiSelect, selectedSet, marginY, marginTop, marginBottom, isLoading, searchQuery, searchPlaceholder, terminalWidth, }: WizardDialogProps): React.JSX.Element;
export {};
//# sourceMappingURL=wizard-dialog.d.ts.map