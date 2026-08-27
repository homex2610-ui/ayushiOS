import { createBot } from 'mineflayer';

const bot = createBot({
  host: '127.0.0.1',
  port: 63674,
  username: 'CraftDebug',
  auth: 'offline',
});

bot.once('spawn', async () => {
  console.log('=== CRAFT DIAGNOSTIC ===');
  console.log('Bot position:', bot.entity.position);

  // Check what recipesAll returns for sticks
  const stickId = bot.registry.itemsByName['stick']?.id;
  console.log('stick item ID:', stickId);

  const recipesNoTable = bot.recipesAll(stickId, null, null);
  console.log('recipesAll(stick, null, null):', recipesNoTable.length, 'recipes');
  for (const r of recipesNoTable) {
    console.log('  recipe:', JSON.stringify({
      inShape: r.inShape,
      ingredients: r.ingredients,
      result: r.result,
    }));
  }

  const recipesWithTable = bot.recipesAll(stickId, null, true);
  console.log('recipesAll(stick, null, true):', recipesWithTable.length, 'recipes');

  // Check crafting_table recipes
  const tableId = bot.registry.itemsByName['crafting_table']?.id;
  const tableRecipes = bot.recipesAll(tableId, null, null);
  console.log('\nrecipesAll(crafting_table, null, null):', tableRecipes.length, 'recipes');
  for (const r of tableRecipes) {
    console.log('  recipe:', JSON.stringify({
      inShape: r.inShape,
      ingredients: r.ingredients,
      result: r.result,
    }));
  }

  // Check what's in inventory
  const inv = {};
  for (const slot of bot.inventory.slots) {
    if (slot) {
      inv[slot.name] = (inv[slot.name] || 0) + slot.count;
    }
  }
  console.log('\nInventory:', JSON.stringify(inv));

  // Try to craft a crafting_table directly
  console.log('\n--- Attempting to craft crafting_table ---');
  try {
    const tableRecipes2 = bot.recipesAll(tableId, null, null);
    if (tableRecipes2.length > 0) {
      console.log('Found recipe, attempting craft...');
      await bot.craft(tableRecipes2[0], 1, null);
      console.log('SUCCESS: crafted crafting_table!');
    } else {
      console.log('NO recipes found for crafting_table without table!');
    }
  } catch (e) {
    console.log('FAILED:', e.message);
  }

  // Check inventory after
  const inv2 = {};
  for (const slot of bot.inventory.slots) {
    if (slot) {
      inv2[slot.name] = (inv2[slot.name] || 0) + slot.count;
    }
  }
  console.log('Inventory after craft attempt:', JSON.stringify(inv2));

  // Try sticks
  console.log('\n--- Attempting to craft sticks ---');
  try {
    const stickRecipes = bot.recipesAll(stickId, null, null);
    if (stickRecipes.length > 0) {
      console.log('Found recipe, attempting craft...');
      await bot.craft(stickRecipes[0], 1, null);
      console.log('SUCCESS: crafted sticks!');
    } else {
      console.log('NO recipes found for sticks without table!');
    }
  } catch (e) {
    console.log('FAILED:', e.message);
  }

  const inv3 = {};
  for (const slot of bot.inventory.slots) {
    if (slot) {
      inv3[slot.name] = (inv3[slot.name] || 0) + slot.count;
    }
  }
  console.log('Inventory after stick attempt:', JSON.stringify(inv3));

  console.log('\n=== DIAGNOSTIC COMPLETE ===');
  bot.quit();
  process.exit(0);
});

bot.on('error', (e) => console.error('Bot error:', e.message));
bot.on('kicked', (r) => console.error('Kicked:', r));
