import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'staff_session.dart';

class BranchPicker extends StatelessWidget {
  const BranchPicker({super.key});

  @override
  Widget build(BuildContext context) {
    final staff = context.watch<StaffSession>();
    final branches = staff.branches;
    if (branches.length <= 1) return const SizedBox.shrink();
    final current = branches.where((b) => b.id == staff.branchId).firstOrNull;
    return PopupMenuButton<String>(
      tooltip: 'Branch',
      initialValue: staff.branchId,
      onSelected: staff.selectBranch,
      itemBuilder: (_) => branches.map((b) => PopupMenuItem(value: b.id, child: Text(b.name))).toList(),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.storefront_outlined, size: 18),
          const SizedBox(width: 4),
          ConstrainedBox(constraints: const BoxConstraints(maxWidth: 140), child: Text(current?.name ?? 'Branch', overflow: TextOverflow.ellipsis)),
          const Icon(Icons.arrow_drop_down),
        ]),
      ),
    );
  }
}
