import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmAction, FormDialog } from '@/components/common';

type BaseAction = { label: string; disabled?: boolean };
export type RowAction =
  | (BaseAction & { kind: 'link'; to: string })
  | (BaseAction & { kind: 'callback'; onSelect: () => void })
  | (BaseAction & {
      kind: 'confirm';
      action: string;
      title?: string;
      description?: string;
      destructive?: boolean;
    })
  | (BaseAction & {
      kind: 'form';
      action: string;
      title: string;
      description?: string;
      submitLabel?: string;
      children: ReactNode;
    });

/** One consistent table-cell action picker; confirmation and form dialogs remain mounted
 * after the dropdown closes, so destructive operations still require an explicit choice. */
export function RowActions({
  resource,
  actions,
}: {
  resource: string;
  actions: RowAction[];
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const firstDestructive = actions.findIndex(
    (action) => action.kind === 'confirm' && action.destructive,
  );

  return (
    <div className="flex justify-end">
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-label={'Actions for ' + resource}
            aria-haspopup="menu"
            className="min-w-28 justify-between gap-2"
          >
            <MoreHorizontal className="size-4" />
            Actions
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48"
          onCloseAutoFocus={(event) => {
            if (selected !== null) event.preventDefault();
          }}
        >
          {actions.map((item, index) => (
            <Fragment key={item.label + ':' + index}>
              {index === firstDestructive && index > 0 && <DropdownMenuSeparator />}
              {item.kind === 'link' ? (
                <DropdownMenuItem asChild disabled={item.disabled}>
                  <Link to={item.to}>{item.label}</Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={item.disabled}
                  variant={item.kind === 'confirm' && item.destructive ? 'destructive' : 'default'}
                  onSelect={() => {
                    if (item.kind === 'callback') item.onSelect();
                    else setSelected(index);
                  }}
                >
                  {item.label}
                </DropdownMenuItem>
              )}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {actions.map((item, index) => {
        if (item.kind === 'confirm') {
          return (
            <ConfirmAction
              key={index}
              label={item.label}
              action={item.action}
              title={item.title}
              description={item.description}
              destructive={item.destructive}
              hideTrigger
              open={selected === index}
              onOpenChange={(open) => { if (!open) setSelected(null); }}
            />
          );
        }
        if (item.kind === 'form') {
          return (
            <FormDialog
              key={index}
              title={item.title}
              description={item.description}
              action={item.action}
              submitLabel={item.submitLabel}
              open={selected === index}
              onOpenChange={(open) => { if (!open) setSelected(null); }}
            >
              {item.children}
            </FormDialog>
          );
        }
        return null;
      })}
    </div>
  );
}
