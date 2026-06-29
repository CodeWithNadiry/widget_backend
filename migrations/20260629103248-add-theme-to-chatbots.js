export async function up(queryInterface, DataTypes) {
  await queryInterface.addColumn("chatbots", "theme", {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: {
      primaryColor: "#2563eb",
      headerBg:     "#0f172a",
      aiBubbleBg:   "#ffffff",
    },
  });
}

export async function down(queryInterface) {
  await queryInterface.removeColumn("chatbots", "theme");
}